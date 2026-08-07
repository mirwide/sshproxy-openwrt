# sshproxy-openwrt: apk packaging image.
#
# Contains apk-tools 3.x (the same version OpenWrt 25.12 ships, v3/adb
# packages) installed from the Alpine package repository and the
# tools needed to cross-compile the pure-Go binary. The repository is mounted
# read-write at /src by ci/docker-apk.sh and the actual build (pure-Go
# cross-compile of the binary + `apk mkpkg`) runs via ci/build.sh.

FROM golang:1.26-alpine

RUN apk add --no-cache \
        apk-tools \
        ca-certificates curl git make

CMD ["/bin/sh"]
