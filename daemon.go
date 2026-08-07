package main

import (
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"
)

// runDaemon — режим демона: устанавливает правила пересылки, запускает прокси
// и при получении SIGTERM/SIGINT удаляет правила и завершает работу.
func runDaemon(cfg *Config, backend string) error {
	if err := applyFirewall(cfg, backend); err != nil {
		return fmt.Errorf("setup rules: %w", err)
	}
	log.Printf("rules installed for %d subnet(s): %v", len(cfg.Subnets), cfg.Subnets)

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)

	done := make(chan error, 1)
	go func() {
		done <- NewProxy(cfg).Run()
	}()

	select {
	case sig := <-stop:
		log.Printf("received %s, cleaning up", sig)
	case err := <-done:
		return err
	}

	if err := flushFirewall(cfg, backend); err != nil {
		log.Printf("teardown rules: %v", err)
		return nil
	}
	log.Printf("rules removed")
	return nil
}
