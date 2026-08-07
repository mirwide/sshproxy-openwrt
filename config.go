package main

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
)

// Config описывает конфигурацию прокси.
type Config struct {
	// SSH — параметры подключения к SSH-серверу.
	SSH SSHConfig `json:"ssh"`

	// Listen — адрес, на котором прозрачный прокси принимает
	// перенаправленный nftables/iptables трафик, например "0.0.0.0:1080".
	Listen string `json:"listen"`

	// Subnets — список подсетей, трафик к которым пересылается на порт.
	// Например ["8.8.8.0/24", "10.0.0.0/8"].
	Subnets []string `json:"subnets"`

	// Firewall — тип генерируемых правил: "nft" или "iptables".
	// Пустое значение = автоопределение по наличию бинарников.
	Firewall string `json:"firewall,omitempty"`
}

// SSHConfig — параметры SSH-соединения.
type SSHConfig struct {
	// Server — адрес SSH-сервера "host:port".
	Server string `json:"server"`

	// User — имя пользователя SSH.
	User string `json:"user"`

	// Password — пароль (если используется аутентификация паролем).
	Password string `json:"password,omitempty"`

	// KeyFile — путь к приватному ключу (опционально).
	KeyFile string `json:"key_file,omitempty"`

	// KeyPassphrase — парольная фраза для зашифрованного ключа.
	KeyPassphrase string `json:"key_passphrase,omitempty"`

	// KnownHosts — путь к known_hosts (по умолчанию ~/.ssh/known_hosts).
	KnownHosts string `json:"known_hosts,omitempty"`

	// IgnoreHostKey — не проверять ключ хоста SSH (не рекомендуется).
	IgnoreHostKey bool `json:"ignore_host_key,omitempty"`
}

// loadConfig читает конфигурацию из JSON-файла и проверяет её.
func loadConfig(path string) (*Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read config: %w", err)
	}

	var cfg Config
	if err := json.Unmarshal(data, &cfg); err != nil {
		return nil, fmt.Errorf("parse config: %w", err)
	}

	if cfg.SSH.Server == "" {
		return nil, fmt.Errorf("config: ssh.server is required")
	}
	if cfg.SSH.User == "" {
		return nil, fmt.Errorf("config: ssh.user is required")
	}
	if cfg.SSH.Password == "" && cfg.SSH.KeyFile == "" {
		return nil, fmt.Errorf("config: ssh.password or ssh.key_file is required")
	}
	if cfg.Listen == "" {
		return nil, fmt.Errorf("config: listen is required")
	}
	if _, _, err := net.SplitHostPort(cfg.Listen); err != nil {
		return nil, fmt.Errorf("config: listen must be host:port: %w", err)
	}
	if len(cfg.Subnets) == 0 {
		return nil, fmt.Errorf("config: at least one subnet is required")
	}
	for _, s := range cfg.Subnets {
		if _, _, err := net.ParseCIDR(s); err != nil {
			return nil, fmt.Errorf("config: invalid subnet %q: %w", s, err)
		}
	}

	return &cfg, nil
}

// listenIP возвращает IP-адрес из Listen (или 127.0.0.1, если не указан).
func (c *Config) listenIP() string {
	host, _, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return "127.0.0.1"
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		return "127.0.0.1"
	}
	return host
}

// listenPort возвращает порт из Listen.
func (c *Config) listenPort() string {
	_, port, err := net.SplitHostPort(c.Listen)
	if err != nil {
		return "1080"
	}
	return port
}
