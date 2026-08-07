GO      ?= go
VERSION ?= $(shell git describe --tags --always 2>/dev/null || echo dev)
BUILD_DIR ?= bin
LDFLAGS ?=          # extra linker flags (e.g. -static for a fully static binary)

# When LDFLAGS contains -static the Go binary is linked statically too:
# -extldflags=-static plus pure-Go net/user so no libc dependencies leak
# into the final binary (needed on OpenWrt).
ifneq ($(filter -static,$(LDFLAGS)),)
GO_EXTLDFLAGS := -extldflags=-static
GO_TAGS       := netgo,osusergo
else
GO_EXTLDFLAGS :=
GO_TAGS       :=
endif

# --- apk packaging (OpenWrt >= 25.12, apk-tools >= 3) ---
#
# All .apk builds run inside Docker (ci/Dockerfile builds apk-tools from
# source). Public targets are:
#   make riscv64-apk                  # riscv64_generic
#   make arm64-apk                    # aarch64_generic
#   make apk ARCH=x86_64              # any supported ARCH
#   make apk ARCH=x86_64 APK_KEY=~/sshproxy.rsa    # signed package
#
# `apk-in-docker` is the internal target executed inside the image by
# ci/build.sh and is not meant to be run on the host.

PKG_NAME       ?= sshproxy-openwrt
PKG_VERSION    ?= 0.1
PKG_RELEASE    ?= 1
ARCH           ?= riscv64_generic
APK_KEY        ?=          # path to RSA private key (PEM) to sign the package
APK            ?= apk
APK_VERSION    ?= $(PKG_VERSION)-r$(PKG_RELEASE)
APK_DIR        := $(BUILD_DIR)/apk
APK_DATA       := $(APK_DIR)/$(ARCH)/data
APK_FILE       := $(PKG_NAME)-$(APK_VERSION).apk
APK_PATH       := $(APK_DIR)/$(ARCH)/$(APK_FILE)
APK_MKPKG      := $(APK) mkpkg \
	--info "name:$(PKG_NAME)" \
	--info "version:$(APK_VERSION)" \
	--info "description:Transparent SSH proxy: redirects traffic to subnets through an SSH tunnel" \
	--info "arch:$(ARCH)" \
	--info "license:MIT" \
	--info "origin:$(PKG_NAME)" \
	--info "maintainer:sshproxy-openwrt" \
	--info "depends:nftables" \
	$(if $(APK_KEY),--sign-key "$(APK_KEY)") \
	--files "$(APK_DATA)" \
	--output "$(APK_PATH)"

.PHONY: all build openwrt riscv64 arm64 \
        apk riscv64-apk arm64-apk apk-in-docker \
        test vet fmt install clean

all: build

# Host build (for development).
build:
	mkdir -p $(BUILD_DIR)
	$(GO) build -tags "$(GO_TAGS)" -trimpath \
		-ldflags "-s -w -X github.com/mirwide/sshproxy-openwrt.version=$(VERSION) $(GO_EXTLDFLAGS)" \
		-o $(BUILD_DIR)/sshproxy .

riscv64:
	$(MAKE) openwrt GOARCH=riscv64

arm64:
	$(MAKE) openwrt GOARCH=arm64

test:
	$(GO) test ./...

vet:
	$(GO) vet ./...

fmt:
	gofmt -l -w .

install:
	$(GO) install -trimpath -ldflags "-s -w -X github.com/mirwide/sshproxy-openwrt.version=$(VERSION)" .

# --- public apk targets: run inside Docker ---
apk:
	sh ci/docker-apk.sh "$(ARCH)" $(if $(APK_KEY),APK_KEY=$(APK_KEY))

riscv64-apk:
	sh ci/docker-apk.sh riscv64_generic $(if $(APK_KEY),APK_KEY=$(APK_KEY))

arm64-apk:
	sh ci/docker-apk.sh aarch64_generic $(if $(APK_KEY),APK_KEY=$(APK_KEY))

# --- apk data payload (staged by ci/build.sh inside the image) ---
$(APK_DATA)/usr/bin/sshproxy-openwrt: $(BINARY)
	@mkdir -p $(dir $@)
	install -m 0755 $< $@

$(APK_DATA)/etc/init.d/sshproxy: files/etc/init.d/sshproxy
	@mkdir -p $(dir $@)
	install -m 0755 $< $@

$(APK_DATA)/etc/config/sshproxy: files/etc/config/sshproxy
	@mkdir -p $(dir $@)
	install -m 0644 $< $@

$(APK_DATA)/etc/sshproxy/config.json: files/etc/sshproxy/config.json
	@mkdir -p $(dir $@)
	install -m 0644 $< $@

APK_FILES := $(APK_DATA)/usr/bin/sshproxy-openwrt \
             $(APK_DATA)/etc/init.d/sshproxy \
             $(APK_DATA)/etc/config/sshproxy \
             $(APK_DATA)/etc/sshproxy/config.json

$(APK_PATH): $(APK_FILES)
	@$(APK) --version 2>/dev/null | grep -qE '^apk-tools [3-9]\.' || { \
		echo "error: apk packaging needs apk-tools >= 3 (as shipped with OpenWrt 25.12)" >&2; \
		echo "  this target runs inside Docker; use 'make riscv64-apk' instead" >&2; \
		exit 1; }; \
	touch -h -d "@$(SOURCE_DATE_EPOCH)" $(APK_FILES) 2>/dev/null || true; \
	if command -v fakeroot >/dev/null 2>&1; then \
		echo "fakeroot: packaging files as root:root"; \
		fakeroot sh -e -c 'chown -h 0:0 $(APK_FILES) 2>/dev/null; exec $(APK_MKPKG)'; \
	else \
		echo "note: fakeroot not found; package files will be owned by the build user" >&2; \
		$(APK_MKPKG); \
	fi

# Internal target: package a prebuilt binary. Used by ci/build.sh inside the
# image, where BINARY and APK point at the container's cross-built binary and
# apk-tools respectively.
apk-in-docker: $(APK_PATH)
	@echo "wrote $(APK_PATH)"

clean:
	rm -rf $(BUILD_DIR)
