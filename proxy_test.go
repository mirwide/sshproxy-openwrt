package main

import (
	"crypto/rand"
	"crypto/rsa"
	"fmt"
	"io"
	"net"
	"testing"
	"time"

	"golang.org/x/crypto/ssh"
)

// startEchoServer запускает TCP-эхо-сервер.
func startEchoServer(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				_, _ = io.Copy(c, c)
			}(c)
		}
	}()
	return ln.Addr().String()
}

// startSSHServer запускает SSH-сервер с аутентификацией по паролю.
// direct-tcpip каналы обрабатываются библиотекой автоматически.
func startSSHServer(t *testing.T) string {
	t.Helper()
	signer, err := rsa.GenerateKey(rand.Reader, 1024)
	if err != nil {
		t.Fatal(err)
	}
	hostKey, err := ssh.NewSignerFromKey(signer)
	if err != nil {
		t.Fatal(err)
	}

	srv := &ssh.ServerConfig{
		PasswordCallback: func(conn ssh.ConnMetadata, password []byte) (*ssh.Permissions, error) {
			return nil, nil
		},
	}
	srv.AddHostKey(hostKey)

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go func(c net.Conn) {
				defer c.Close()
				conn, chans, reqs, err := ssh.NewServerConn(c, srv)
				if err != nil {
					return
				}
				defer conn.Close()
				go ssh.DiscardRequests(reqs)
				for ch := range chans {
					go handleServerChannel(ch)
				}
			}(c)
		}
	}()

	return ln.Addr().String()
}

// handleServerChannel обрабатывает direct-tcpip каналы на стороне сервера.
func handleServerChannel(ch ssh.NewChannel) {
	var payload struct {
		DestHost string
		DestPort uint32
		OrigHost string
		OrigPort uint32
	}
	if err := ssh.Unmarshal(ch.ExtraData(), &payload); err != nil {
		_ = ch.Reject(ssh.ConnectionFailed, "bad payload")
		return
	}

	remote, err := net.Dial("tcp", net.JoinHostPort(payload.DestHost, fmt.Sprint(payload.DestPort)))
	if err != nil {
		_ = ch.Reject(ssh.ConnectionFailed, "dial failed")
		return
	}
	defer remote.Close()

	conn, reqs, err := ch.Accept()
	if err != nil {
		return
	}
	go ssh.DiscardRequests(reqs)

	var wg = make(chan struct{}, 2)
	go func() { _, _ = io.Copy(conn, remote); conn.Close(); wg <- struct{}{} }()
	go func() { _, _ = io.Copy(remote, conn); remote.Close(); wg <- struct{}{} }()
	<-wg
}

// fakeConn — соединение с подменённым LocalAddr для эмуляции TPROXY.
type fakeConn struct {
	net.Conn
	local  net.Addr
	remote net.Addr
}

func (f *fakeConn) LocalAddr() net.Addr  { return f.local }
func (f *fakeConn) RemoteAddr() net.Addr { return f.remote }

// TestProxyForward проверяет полный путь: локальное соединение -> SSH -> эхо.
func TestProxyForward(t *testing.T) {
	dstAddr := startEchoServer(t)
	sshAddr := startSSHServer(t)

	cfg := &Config{
		SSH:     SSHConfig{Server: sshAddr, User: "test", Password: "secret", IgnoreHostKey: true},
		Listen:  "127.0.0.1:1080",
		Subnets: []string{"8.8.8.0/24"},
	}
	p := NewProxy(cfg)

	dstHost, dstPort, _ := net.SplitHostPort(dstAddr)
	local := &net.TCPAddr{IP: net.ParseIP(dstHost), Port: atoi(t, dstPort)}
	remote := &net.TCPAddr{IP: net.ParseIP("127.0.0.1"), Port: 40000}

	left, right := net.Pipe()
	defer left.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		p.handle(&fakeConn{Conn: right, local: local, remote: remote})
	}()

	// Данные должны дойти до эхо-сервера и вернуться.
	msg := []byte("hello through ssh tunnel\n")
	if _, err := left.Write(msg); err != nil {
		t.Fatal(err)
	}

	buf := make([]byte, len(msg))
	left.SetReadDeadline(time.Now().Add(10 * time.Second))
	if _, err := io.ReadFull(left, buf); err != nil {
		t.Fatal(err)
	}
	if string(buf) != string(msg) {
		t.Fatalf("got %q, want %q", buf, msg)
	}

	left.Close()
	<-done
}

func atoi(t *testing.T, s string) int {
	t.Helper()
	var n int
	for _, c := range s {
		if c < '0' || c > '9' {
			t.Fatalf("invalid port %q", s)
		}
		n = n*10 + int(c-'0')
	}
	return n
}
