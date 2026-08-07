package main

import (
	"bytes"
	"fmt"
	"net"
	"os/exec"
	"strings"
)

const (
	tableName = "sshproxy"
	preChain  = "SSHPROXY_PRE"
	outChain  = "SSHPROXY_OUT"
)

// detectBackend выбирает backend генерации правил: "nft" или "iptables".
func detectBackend(force string) (string, error) {
	switch force {
	case "nft":
		return "nft", nil
	case "iptables":
		return "iptables", nil
	case "":
		if _, err := exec.LookPath("nft"); err == nil {
			return "nft", nil
		}
		if _, err := exec.LookPath("iptables"); err == nil {
			return "iptables", nil
		}
		return "", fmt.Errorf("neither nft nor iptables found in PATH")
	default:
		return "", fmt.Errorf("unknown firewall backend %q (want nft or iptables)", force)
	}
}

// checkV4Only возвращает ошибку, если в списке есть IPv6-подсети.
func checkV4Only(subnets []string) error {
	for _, s := range subnets {
		ip, _, err := net.ParseCIDR(s)
		if err != nil {
			return fmt.Errorf("invalid subnet %q: %w", s, err)
		}
		if ip.To4() == nil {
			return fmt.Errorf("subnet %q is IPv6, only IPv4 subnets are supported", s)
		}
	}
	return nil
}

// sshServerIP возвращает IP SSH-сервера для исключения из редиректа.
func sshServerIP(cfg *Config) string {
	host, _, err := net.SplitHostPort(cfg.SSH.Server)
	if err != nil {
		host = cfg.SSH.Server
	}
	if ip := net.ParseIP(host); ip != nil {
		return host
	}
	if addrs, err := net.LookupHost(host); err == nil && len(addrs) > 0 {
		return addrs[0]
	}
	return ""
}

// subnetList форматирует подсети для вставки в nft-правило.
// Без кавычек: закавыченный элемент nft воспринимает как hostname
// и пытается резолвить через DNS.
func subnetList(subnets []string) string {
	return strings.Join(subnets, ", ")
}

// generateNFT собирает ruleset для nftables.
func generateNFT(cfg *Config) string {
	var b strings.Builder
	b.WriteString("table ip " + tableName + " {\n")
	b.WriteString("    chain " + preChain + " {\n")
	b.WriteString("        type nat hook prerouting priority dstnat; policy accept;\n")
	b.WriteString("        ip daddr { " + subnetList(cfg.Subnets) + " } tcp dport != " + cfg.listenPort() + " redirect to :" + cfg.listenPort() + "\n")
	b.WriteString("    }\n")
	b.WriteString("    chain " + outChain + " {\n")
	b.WriteString("        type nat hook output priority dstnat; policy accept;\n")
	b.WriteString("        ip daddr { " + subnetList(cfg.Subnets) + " } tcp dport != " + cfg.listenPort() + " redirect to :" + cfg.listenPort() + "\n")
	b.WriteString("    }\n")
	b.WriteString("}\n")
	return b.String()
}

// generateIPtables возвращает набор команд для iptables.
func generateIPtables(cfg *Config) []string {
	port := cfg.listenPort()
	serverIP := sshServerIP(cfg)

	var rules []string
	rules = append(rules,
		"iptables -t nat -N "+preChain,
		"iptables -t nat -N "+outChain,
	)
	if serverIP != "" {
		rules = append(rules,
			"iptables -t nat -A "+preChain+" -d "+serverIP+" -j RETURN",
			"iptables -t nat -A "+outChain+" -d "+serverIP+" -j RETURN",
		)
	}
	for _, s := range cfg.Subnets {
		rules = append(rules,
			"iptables -t nat -A "+preChain+" -d "+s+" -p tcp --dport "+port+" -j RETURN",
			"iptables -t nat -A "+preChain+" -d "+s+" -p tcp -j REDIRECT --to-ports "+port,
			"iptables -t nat -A "+outChain+" -d "+s+" -p tcp --dport "+port+" -j RETURN",
			"iptables -t nat -A "+outChain+" -d "+s+" -p tcp -j REDIRECT --to-ports "+port,
		)
	}
	rules = append(rules,
		"iptables -t nat -I PREROUTING -j "+preChain,
		"iptables -t nat -I OUTPUT -j "+outChain,
	)
	return rules
}

// applyFirewall устанавливает правила пересылки.
func applyFirewall(cfg *Config, backend string) error {
	if err := checkV4Only(cfg.Subnets); err != nil {
		return err
	}

	switch backend {
	case "nft":
		// Таблица может отсутствовать при первом запуске, поэтому
		// сначала удаляем её (ошибка игнорируется), затем создаём заново.
		_ = runShell("nft delete table ip " + tableName)
		return runStdin("nft", []string{"-f", "-"}, []byte(generateNFT(cfg)))
	case "iptables":
		for _, cmd := range generateIPtables(cfg) {
			if err := runShell(cmd); err != nil {
				return fmt.Errorf("iptables rule failed: %w (%s)", err, cmd)
			}
		}
		return nil
	default:
		return fmt.Errorf("unknown backend %q", backend)
	}
}

// flushFirewall удаляет правила пересылки.
func flushFirewall(cfg *Config, backend string) error {
	switch backend {
	case "nft":
		return runShell("nft delete table ip " + tableName)
	case "iptables":
		// Ошибки игнорируются: правило может отсутствовать.
		_ = runShell("iptables -t nat -D PREROUTING -j " + preChain)
		_ = runShell("iptables -t nat -D OUTPUT -j " + outChain)
		_ = runShell("iptables -t nat -F " + preChain)
		_ = runShell("iptables -t nat -F " + outChain)
		_ = runShell("iptables -t nat -X " + preChain)
		return runShell("iptables -t nat -X " + outChain)
	default:
		return fmt.Errorf("unknown backend %q", backend)
	}
}

func runShell(command string) error {
	cmd := exec.Command("sh", "-c", command)
	return cmd.Run()
}

func runStdin(prog string, args []string, input []byte) error {
	cmd := exec.Command(prog, args...)
	cmd.Stdin = bytes.NewReader(input)
	var errBuf bytes.Buffer
	cmd.Stderr = &errBuf
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("%s: %w: %s", prog, err, strings.TrimSpace(errBuf.String()))
	}
	return nil
}
