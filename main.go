package main

import (
	"flag"
	"fmt"
	"log"
	"os"
)

const usage = `sshproxy-openwrt — прозрачный SSH-прокси для трафика к списку подсетей.

Использование:
  sshproxy-openwrt <config.json> setup     установить правила пересылки (nftables/iptables)
  sshproxy-openwrt <config.json> run       запустить прокси
  sshproxy-openwrt <config.json> daemon    создать правила, запустить прокси, удалить правила при выходе
  sshproxy-openwrt <config.json> teardown  удалить правила пересылки

Конфигурация (JSON):
  {
    "ssh": {
      "server": "vpn.example.com:22",
      "user": "root",
      "password": "...",          // или "key_file"
      "key_file": "/root/.ssh/id_rsa",
      "ignore_host_key": false
    },
    "listen": "0.0.0.0:1080",
    "subnets": ["8.8.8.0/24", "10.0.0.0/8"],
    "firewall": "nft"             // "nft", "iptables" или автоопределение
  }
`

// version задаётся при сборке через -ldflags "-X main.version=...".
var version = "dev"

func main() {
	log.SetFlags(log.LstdFlags | log.Lmsgprefix)
	log.SetPrefix("[sshproxy] ")

	flag.Usage = func() {
		fmt.Fprint(os.Stderr, usage)
		flag.PrintDefaults()
	}

	flag.Parse()

	if flag.NArg() < 2 {
		flag.Usage()
		os.Exit(2)
	}

	configPath := flag.Arg(0)
	command := flag.Arg(1)

	cfg, err := loadConfig(configPath)
	if err != nil {
		log.Fatalf("config: %v", err)
	}
	debugEnabled = cfg.Debug

	backend, err := detectBackend(cfg.Firewall)
	if err != nil {
		log.Fatalf("firewall: %v", err)
	}
	log.Printf("firewall backend: %s", backend)

	switch command {
	case "setup":
		if err := applyFirewall(cfg, backend); err != nil {
			log.Fatalf("setup: %v", err)
		}
		log.Printf("rules installed for %d subnet(s): %v", len(cfg.Subnets), cfg.Subnets)

	case "teardown":
		if err := flushFirewall(cfg, backend); err != nil {
			log.Fatalf("teardown: %v", err)
		}
		log.Printf("rules removed")

	case "run":
		if err := NewProxy(cfg).Run(); err != nil {
			log.Fatalf("run: %v", err)
		}

	case "daemon":
		if err := runDaemon(cfg, backend); err != nil {
			log.Fatalf("daemon: %v", err)
		}

	default:
		log.Fatalf("unknown command %q (want setup, run, daemon or teardown)", command)
	}
}
