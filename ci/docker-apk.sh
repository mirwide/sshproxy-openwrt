#!/bin/sh
# Build the sshproxy-openwrt .apk inside Docker -- no apk-tools or cross
# toolchains needed on the host.
#
#   ci/docker-apk.sh [ARCH]      # default: riscv64_generic
#   ci/docker-apk.sh aarch64_generic
#   ci/docker-apk.sh x86_64 APK_KEY=~/sshproxy.rsa
#
# The repository is mounted into the image, so the built package lands in
# bin/apk/<ARCH>/ as usual. The Go build cache is cached in
# .docker-cache/go-build on the host.

set -eu

cd "$(dirname "$0")/.."

ARCH="${1:-riscv64_generic}"
IMAGE="${IMAGE:-sshproxy-openwrt-apk}"
CACHE_DIR="${CACHE_DIR:-$(pwd)/.docker-cache}"
APK_KEY="${APK_KEY:-}"

command -v docker >/dev/null 2>&1 || {
    echo "error: docker not found in PATH" >&2
    exit 1
}

docker build -t "$IMAGE" ci/

mkdir -p "$CACHE_DIR"/go-build

set -- --rm \
	-e HOME=/tmp \
	-e GOCACHE=/go-build \
	-e ARCH="$ARCH" \
	-v "$(pwd)":/src \
	-v "$CACHE_DIR"/go-build:/go-build \
	-w /src

if [ -n "$APK_KEY" ]; then
	case "$APK_KEY" in
	/*) keyfile="$APK_KEY" ;;
	*) keyfile="$(pwd)/$APK_KEY" ;;
	esac
	if [ ! -f "$keyfile" ]; then
		echo "error: APK_KEY not found: $keyfile" >&2
		exit 1
	fi
	set -- "$@" -v "$keyfile":/key.rsa:ro -e APK_KEY=/key.rsa
fi

exec docker run "$@" "$IMAGE" /src/ci/build.sh
