BINARY  := sshproxy
PKG     := github.com/mirwide/sshproxy-openwrt
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
OUTDIR  := bin

LDFLAGS := -s -w -X $(PKG).version=$(VERSION)

.PHONY: all build run test lint vet fmt clean install

all: build

build:
	mkdir -p $(OUTDIR)
	go build -trimpath -ldflags "$(LDFLAGS)" -o $(OUTDIR)/$(BINARY) .

run: build
	./$(OUTDIR)/$(BINARY)

test:
	go test ./...

vet:
	go vet ./...

lint:
	command -v golangci-lint >/dev/null 2>&1 && golangci-lint run || go vet ./...

fmt:
	gofmt -l -w .

install:
	go install -trimpath -ldflags "$(LDFLAGS)" .

clean:
	rm -rf $(OUTDIR)
