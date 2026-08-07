#!/bin/sh
# Builds the sshproxy-openwrt .apk inside the sshproxy-openwrt-apk image.
#
# Runs from the repository root (mounted at /src by ci/docker-apk.sh).
# ARCH selects the OpenWrt target architecture; the binary is cross-compiled
# with pure Go (no C toolchain needed). The package is written to
# bin/apk/<ARCH>/.

set -e

ARCH="${ARCH:-riscv64_generic}"
APK=/opt/apk-tools/bin/apk

case "$ARCH" in
riscv64_generic)
	GOARCH=riscv64
	;;
aarch64_generic|aarch64_cortex-a53|aarch64_*)
	GOARCH=arm64
	;;
x86_64)
	GOARCH=amd64
	;;
*)
	echo "error: unsupported ARCH=$ARCH" >&2
	echo "  supported: riscv64_generic, aarch64_generic, aarch64_cortex-a53, x86_64" >&2
	exit 1
	;;
esac

APK_KEY_ARG=
if [ -n "${APK_KEY:-}" ]; then
	APK_KEY_ARG="APK_KEY=$APK_KEY"
fi

make openwrt GOARCH="$GOARCH" LDFLAGS=-static
make apk-in-docker BINARY=bin/sshproxy-openwrt-$GOARCH \
	ARCH="$ARCH" APK="$APK" $APK_KEY_ARG

echo
echo "==> built: bin/apk/$ARCH/sshproxy-openwrt-*.apk"
