package main

import (
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/crypto/ssh"
	"golang.org/x/crypto/ssh/knownhosts"
	"golang.org/x/sys/unix"
)

// soOriginalDst — getsockopt(IPPROTO_IP, SO_ORIGINAL_DST),
// возвращает исходный адресат для REDIRECT-соединений.
const soOriginalDst = 80

// timeout — таймаут установки SSH-соединения.
const timeout = 10 * time.Second

// Proxy — прозрачный прокси поверх SSH.
type Proxy struct {
	cfg *Config

	mu     sync.Mutex
	client *ssh.Client
}

// NewProxy создаёт прокси.
func NewProxy(cfg *Config) *Proxy {
	return &Proxy{cfg: cfg}
}

// Run запускает приём перенаправленного трафика.
func (p *Proxy) Run() error {
	ln, err := net.Listen("tcp", p.cfg.Listen)
	if err != nil {
		return fmt.Errorf("listen %s: %w", p.cfg.Listen, err)
	}
	defer ln.Close()

	log.Printf("sshproxy: listening on %s", p.cfg.Listen)

	for {
		conn, err := ln.Accept()
		if err != nil {
			var ne net.Error
			if errors.As(err, &ne) && ne.Timeout() {
				continue
			}
			log.Printf("accept: %v", err)
			continue
		}
		go p.handle(conn)
	}
}

// handle обрабатывает одно перенаправленное соединение.
func (p *Proxy) handle(conn net.Conn) {
	defer conn.Close()

	dst, err := originalDst(conn)
	if err != nil {
		log.Printf("connection from %s: %v", conn.RemoteAddr(), err)
		return
	}
	if isSelfDst(dst, p.cfg.Listen) {
		// Прямое подключение к прокси-порту (не через REDIRECT) — не туннелируем.
		log.Printf("connection to proxy itself from %s ignored (dst=%s)", conn.RemoteAddr(), dst)
		return
	}
	log.Printf("forward %s -> %s via %s", conn.RemoteAddr(), dst, p.cfg.SSH.Server)

	for attempt := 0; attempt < 2; attempt++ {
		client, err := p.getClient()
		if err != nil {
			log.Printf("ssh dial: %v", err)
			return
		}

		remote, err := client.Dial("tcp", dst)
		if err == nil {
			relay(conn, remote)
			return
		}

		log.Printf("dial %s via ssh: %v", dst, err)
		p.invalidateClient() // повторная попытка с новым SSH-соединением
	}
}

// getClient возвращает живое SSH-соединение, при необходимости переподключаясь.
func (p *Proxy) getClient() (*ssh.Client, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.client != nil {
		return p.client, nil
	}

	client, err := dialSSH(&p.cfg.SSH)
	if err != nil {
		return nil, err
	}

	p.client = client
	go p.watch(client)
	return client, nil
}

// invalidateClient сбрасывает SSH-соединение для переподключения.
func (p *Proxy) invalidateClient() {
	p.mu.Lock()
	if p.client != nil {
		p.client.Close()
		p.client = nil
	}
	p.mu.Unlock()
}

// watch дожидается закрытия SSH-соединения и сбрасывает его.
func (p *Proxy) watch(client *ssh.Client) {
	_ = client.Wait()
	p.mu.Lock()
	if p.client == client {
		p.client = nil
	}
	p.mu.Unlock()
	log.Printf("ssh: connection to %s closed", p.cfg.SSH.Server)
}

// dialSSH устанавливает SSH-соединение с сервером.
func dialSSH(sshCfg *SSHConfig) (*ssh.Client, error) {
	config := &ssh.ClientConfig{
		User:            sshCfg.User,
		Auth:            []ssh.AuthMethod{},
		Timeout:         timeout,
		HostKeyCallback: ssh.InsecureIgnoreHostKey(),
	}

	if sshCfg.IgnoreHostKey {
		config.HostKeyCallback = ssh.InsecureIgnoreHostKey()
	} else {
		cb, err := hostKeyCallback(sshCfg)
		if err != nil {
			return nil, err
		}
		config.HostKeyCallback = cb
	}

	if sshCfg.Password != "" {
		config.Auth = append(config.Auth, ssh.Password(sshCfg.Password))
	}
	if sshCfg.KeyFile != "" {
		signer, err := loadSigner(sshCfg.KeyFile, sshCfg.KeyPassphrase)
		if err != nil {
			return nil, err
		}
		config.Auth = append(config.Auth, ssh.PublicKeys(signer))
	}

	return ssh.Dial("tcp", sshCfg.Server, config)
}

// hostKeyCallback возвращает проверку ключа хоста по known_hosts.
func hostKeyCallback(sshCfg *SSHConfig) (ssh.HostKeyCallback, error) {
	path := sshCfg.KnownHosts
	if path == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, fmt.Errorf("known_hosts: %w", err)
		}
		path = filepath.Join(home, ".ssh", "known_hosts")
	}
	cb, err := knownhosts.New(path)
	if err != nil {
		return nil, fmt.Errorf("known_hosts %s: %w", path, err)
	}
	return cb, nil
}

// loadSigner загружает и расшифровывает приватный ключ.
func loadSigner(path, passphrase string) (ssh.Signer, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("read key %s: %w", path, err)
	}
	if passphrase != "" {
		return ssh.ParsePrivateKeyWithPassphrase(data, []byte(passphrase))
	}
	return ssh.ParsePrivateKey(data)
}

// isSelfDst возвращает true, если dst — адрес самого прокси
// (прямое подключение к порту прослушивания, а не через REDIRECT).
func isSelfDst(dst, listen string) bool {
	host, port, err := net.SplitHostPort(dst)
	if err != nil {
		return false
	}

	_, lport, err := net.SplitHostPort(listen)
	if err != nil || port != lport {
		return false
	}

	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() {
		return true
	}

	lhost, _, _ := net.SplitHostPort(listen)
	wildcard := lhost == "" || lhost == "0.0.0.0" || lhost == "::"
	if lip := net.ParseIP(lhost); lip != nil && !wildcard {
		return lip.Equal(ip)
	}
	if wildcard {
		return isLocalIP(ip)
	}
	return false
}

// isLocalIP проверяет, принадлежит ли IP одной из локальных интерфейсов.
func isLocalIP(ip net.IP) bool {
	ifaces, err := net.Interfaces()
	if err != nil {
		return false
	}
	for _, iface := range ifaces {
		addrs, err := iface.Addrs()
		if err != nil {
			continue
		}
		for _, addr := range addrs {
			if ipn, ok := addr.(*net.IPNet); ok && ipn.IP.Equal(ip) {
				return true
			}
		}
	}
	return false
}

// relay копирует данные в обе стороны между локальным и удалённым соединением.
func relay(local, remote net.Conn) {
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		_, _ = io.Copy(remote, local)
		_ = remote.Close()
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(local, remote)
		_ = local.Close()
	}()

	wg.Wait()
}

// originalDst возвращает исходный адресат перенаправленного соединения.
// Приоритет: SO_ORIGINAL_DST (REDIRECT), затем LocalAddr (TPROXY).
func originalDst(conn net.Conn) (string, error) {
	if tcp, ok := conn.(*net.TCPConn); ok {
		if dst, err := originalDstSockopt(tcp); err == nil {
			return dst, nil
		}
	}

	// Запасной вариант: для TPROXY сокет привязан к исходному адресату.
	if addr := conn.LocalAddr(); addr != nil {
		host, port, err := net.SplitHostPort(addr.String())
		if err == nil && net.ParseIP(host) != nil {
			return net.JoinHostPort(host, port), nil
		}
	}
	return "", fmt.Errorf("cannot determine original destination")
}

// originalDstSockopt получает исходный адресат через SO_ORIGINAL_DST.
func originalDstSockopt(tcp *net.TCPConn) (string, error) {
	raw, err := tcp.SyscallConn()
	if err != nil {
		return "", err
	}

	var dst string
	var opErr error
	err = raw.Control(func(fd uintptr) {
		host, port, err := originalDstRaw(int(fd))
		if err != nil {
			opErr = err
			return
		}
		dst = net.JoinHostPort(host, port)
	})
	if err != nil {
		return "", err
	}
	if opErr != nil {
		return "", opErr
	}
	return dst, nil
}

// originalDstRaw вызывает getsockopt(SO_ORIGINAL_DST) напрямую.
func originalDstRaw(fd int) (string, string, error) {
	var sa unix.RawSockaddrInet4
	saLen := uint32(unix.SizeofSockaddrInet4)

	_, _, errno := unix.Syscall6(
		unix.SYS_GETSOCKOPT,
		uintptr(fd),
		uintptr(unix.IPPROTO_IP),
		uintptr(soOriginalDst),
		uintptr(unsafe.Pointer(&sa)),
		uintptr(unsafe.Pointer(&saLen)),
		0,
	)
	if errno != 0 {
		return "", "", errno
	}
	if sa.Family != unix.AF_INET {
		return "", "", fmt.Errorf("unexpected address family %d", sa.Family)
	}

	host := net.IPv4(sa.Addr[0], sa.Addr[1], sa.Addr[2], sa.Addr[3]).String()
	port := fmt.Sprint(uint16(sa.Port>>8) | uint16(sa.Port<<8))
	return host, port, nil
}
