#!/bin/sh
# Mirrors docker/worker/Dockerfile's Playwright block.
#
# `--with-deps` is the part sessions genuinely cannot do for themselves: it
# apt-installs Chromium's shared libraries and fonts, which needs root, and the
# image drops to a non-root user. PLAYWRIGHT_BROWSERS_PATH puts the browsers at
# a shared path so they survive whichever user or repo invokes Playwright, and
# the tree is chowned so a session can still add a browser build at runtime if
# its repo pins a Playwright whose Chromium revision differs from this one.
set -eu

PLAYWRIGHT_VERSION="${VERSION:-1.62.0}"
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
