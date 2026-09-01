#!/bin/sh
# Mirrors docker/worker/Dockerfile's actionlint block. Arch comes from `uname`
# rather than `dpkg --print-architecture` as the Dockerfile does, because a
# Feature must not assume a Debian base.
set -eu

ACTIONLINT_VERSION="${VERSION:-1.7.12}"

case "$(uname -m)" in
x86_64) arch=amd64 ;;
aarch64 | arm64) arch=arm64 ;;
*) echo "(!) no actionlint build for $(uname -m)." >&2 && exit 1 ;;
esac

base="https://github.com/rhysd/actionlint/releases/download/v${ACTIONLINT_VERSION}"
tarball="actionlint_${ACTIONLINT_VERSION}_linux_${arch}.tar.gz"
sums="actionlint_${ACTIONLINT_VERSION}_checksums.txt"

TMP="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '${TMP}'" EXIT
cd "${TMP}"

curl -fsSLO "${base}/${tarball}"
curl -fsSLO "${base}/${sums}"
grep " ${tarball}\$" "${sums}" | sha256sum -c -
tar -xzf "${tarball}" actionlint
install -m 0755 actionlint /usr/local/bin/actionlint
