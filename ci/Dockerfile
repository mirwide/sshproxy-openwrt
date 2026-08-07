# sshproxy-openwrt: apk packaging image.
#
# Contains apk-tools 3.x (the same version OpenWrt 25.12 ships, v3/adb
# packages), fakeroot and the tools needed to build apk-tools itself.
# The repository is mounted read-write at /src by ci/docker-apk.sh and
# the actual build (pure-Go cross-compile of the binary + `apk mkpkg`) runs
# via ci/build.sh.

FROM golang:1.26-bookworm

# Tools to build apk-tools from source.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl git make \
        build-essential pkg-config \
        libssl-dev zlib1g-dev \
        meson ninja-build \
        fakeroot lua5.4 liblua5.4-dev \
    && update-alternatives --install /usr/bin/faked faked /usr/bin/faked-sysv 10 \
    && rm -rf /var/lib/apt/lists/*

# apk-tools 3.0.5 -- the exact commit OpenWrt 25.12 builds.
ARG APK_TOOLS_COMMIT=b5a31c0d865342ad80be10d68f1bb3d3ad9b0866
RUN git clone https://gitlab.alpinelinux.org/alpine/apk-tools.git /tmp/apk-tools \
    && git -C /tmp/apk-tools checkout "$APK_TOOLS_COMMIT" \
    && meson setup /tmp/apk-tools/build /tmp/apk-tools \
        --prefix=/opt/apk-tools --libdir=lib \
        -Ddocs=disabled -Dhelp=disabled \
        -Dlua_version=5.4 -Dlua_pc=lua5.4 -Dlua_bin=lua5.4 \
    && ninja -C /tmp/apk-tools/build \
    && ninja -C /tmp/apk-tools/build install \
    && rm -rf /tmp/apk-tools \
    && echo /opt/apk-tools/lib > /etc/ld.so.conf.d/apk-tools.conf \
    && ldconfig

ENV PATH="/opt/apk-tools/bin:$PATH"

CMD ["/bin/sh"]
