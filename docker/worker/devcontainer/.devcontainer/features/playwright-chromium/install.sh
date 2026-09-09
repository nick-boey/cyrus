#!/bin/sh
# Mirrors docker/worker/Dockerfile's Playwright block.
#
# `--with-deps` is the part sessions genuinely cannot do for themselves: it
# apt-installs Chromium's shared libraries and fonts, which needs root, and the
# image drops to a non-root user. That half is revision-independent.
#
# The browser binary is only a warm cache: the revision Playwright launches is
# decided by the repository's own `playwright-core` pin, and a mismatch is
# survivable because the Playwright CDN is allowlisted for sandbox egress
# (CYR-87). PLAYWRIGHT_BROWSERS_PATH puts the browsers at a shared path so they
# survive whichever user or repo invokes Playwright and a runtime install is
# paid once per container; the tree is chowned because that install runs as the
# non-root user.
set -eu

PLAYWRIGHT_VERSION="${VERSION:-1.60.0}"
BROWSERS_PATH=/ms-playwright
# _REMOTE_USER is supplied by the devcontainer CLI from the config's
# remoteUser/containerUser. It is empty only when nothing set either, in which
# case the image runs as root and the chown is a no-op anyway.
OWNER="${_REMOTE_USER:-root}"

if ! command -v npm >/dev/null 2>&1; then
	echo "(!) playwright-chromium requires npm on the base image or the node Feature." >&2
	exit 1
fi

export PLAYWRIGHT_BROWSERS_PATH="${BROWSERS_PATH}"
npm install -g "playwright@${PLAYWRIGHT_VERSION}"
playwright install --with-deps chromium

if id -u "${OWNER}" >/dev/null 2>&1; then
	chown -R "${OWNER}" "${BROWSERS_PATH}"
fi
rm -rf /var/lib/apt/lists/* /root/.npm
