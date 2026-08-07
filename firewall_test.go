package main

import "testing"

func testConfig() *Config {
	return &Config{
		SSH:     SSHConfig{Server: "vpn.example.com:22", User: "root", Password: "x"},
		Listen:  "0.0.0.0:1080",
		Subnets: []string{"8.8.8.0/24", "10.0.0.0/8"},
	}
}

func TestGenerateNFT(t *testing.T) {
	out := generateNFT(testConfig())
	t.Logf("\n%s", out)
}

func TestGenerateIPtables(t *testing.T) {
	for _, cmd := range generateIPtables(testConfig()) {
		t.Logf("%s", cmd)
	}
}
