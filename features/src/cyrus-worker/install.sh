#!/bin/sh
# Cyrus worker devcontainer Feature.
#
# ADR 0006 makes the repository's devcontainer image the base and Cyrus a
# Feature on top. That inverts who guarantees the boot contract: everything
# `docker/worker/Dockerfile` gets for free by owning the whole image, this
# script has to establish on a base that knows nothing about Cyrus.
#
# Hence POSIX sh and no bash: `bash` is not on an Alpine base, and a Feature
# that assumes it fails at the first line with an error pointing nowhere near
# here. Same reason nothing below assumes apt, glibc, or a pre-existing Node.
#
# What this CANNOT do, by construction: set the image's USER or ENTRYPOINT.
# A Feature only contributes RUN layers, and the devcontainer CLI emits
# `USER $_DEV_CONTAINERS_IMAGE_USER` where that arg is the BASE image's user
# (spec-node/containerFeatures.ts) and emits no ENTRYPOINT at all. Both must be
# applied by the build pipeline in a final stage over the built image. This
# script writes /entrypoint.sh and leaves it to be selected.
set -eu

VERSION="${VERSION:-latest}"
TARBALL="${TARBALL:-}"
NODE_VERSION="${NODEVERSION:-22.22.0}"
USERNAME="${USERNAME:-cyrus}"
USER_UID="${UID:-1001}"
USER_GID="${GID:-1001}"
WORKSPACES_DIR="${WORKSPACESDIR:-/workspaces}"
REPO_CACHE_DIR="${REPOCACHEDIR:-/var/cache/repos}"
GH_VERSION="${GHVERSION:-2.63.2}"

# Installed under one prefix so the whole worker is removable, inspectable, and
# — most importantly — namespaced away from anything the repository installs.
WORKER_HOME=/opt/cyrus-worker
NODE_HOME="${WORKER_HOME}/node"
NODE_BIN="${NODE_HOME}/bin/node"

if [ "$(id -u)" -ne 0 ]; then
	echo "(!) cyrus-worker must install as root." >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# Base family detection. Mirrors the official Features' ADJUSTED_ID so we
# support the same set of bases they do rather than a different one.
# ---------------------------------------------------------------------------
if [ ! -r /etc/os-release ]; then
	echo "(!) cyrus-worker cannot identify this base: /etc/os-release is missing." >&2
	exit 1
fi
. /etc/os-release
case "${ID:-}${ID_LIKE:-}" in
*alpine*) FAMILY=alpine ;;
*debian* | *ubuntu*) FAMILY=debian ;;
*rhel* | *fedora* | *centos*) FAMILY=rhel ;;
*azurelinux* | *mariner*) FAMILY=azurelinux ;;
*) echo "(!) cyrus-worker does not support base '${ID:-unknown}'." >&2 && exit 1 ;;
esac

pkg_install() {
	case "${FAMILY}" in
	alpine) apk add --no-cache "$@" ;;
	debian)
		export DEBIAN_FRONTEND=noninteractive
		apt-get update -y
		apt-get install -y --no-install-recommends "$@"
		rm -rf /var/lib/apt/lists/*
		;;
	rhel)
		if command -v dnf >/dev/null 2>&1; then dnf install -y "$@" && dnf clean all
		elif command -v microdnf >/dev/null 2>&1; then microdnf install -y "$@" && microdnf clean all
		else yum install -y "$@" && yum clean all; fi
		;;
	azurelinux) tdnf install -y "$@" && tdnf clean all ;;
	esac
}

# ---------------------------------------------------------------------------
# The tools container-boot shells out to. `git` and `gh` are load-bearing (the
# clone and its credential helper); `curl` and `jq` are used by Claude sessions
# themselves; `ca-certificates` is what makes node's fetch to the router work
# at all on a slim base.
#
# `gh` is fetched from its release tarball rather than a package: it is absent
# from Debian's own archive, from Alpine's main repo, and from RHEL's — so a
# package-per-family approach has no branch that works everywhere. The binary
# is static Go, so one tarball per arch covers every base here.
# ---------------------------------------------------------------------------
case "${FAMILY}" in
alpine) pkg_install ca-certificates curl git jq tar xz libstdc++ ;;
debian) pkg_install ca-certificates curl git jq tar xz-utils ;;
rhel) pkg_install ca-certificates curl git jq tar xz ;;
azurelinux) pkg_install ca-certificates curl git jq tar xz ;;
esac

arch="$(uname -m)"
case "${arch}" in
x86_64) NODE_ARCH=x64 GH_ARCH=amd64 ;;
aarch64 | arm64) NODE_ARCH=arm64 GH_ARCH=arm64 ;;
*) echo "(!) cyrus-worker has no build for architecture ${arch}." >&2 && exit 1 ;;
esac

TMP="$(mktemp -d)"
# shellcheck disable=SC2064
trap "rm -rf '${TMP}'" EXIT

verify_sha256() {
	# $1 file, $2 expected hex digest. Compared here rather than piped through
	# `sha256sum -c` because the upstream checksum files disagree about their
	# filename column and `-c` fails on the layout it does not expect — the
	# same reason docker/worker/Dockerfile checks rustup's hash by hand.
	actual="$(sha256sum "$1" | cut -d' ' -f1)"
	if [ -z "$2" ] || [ "$2" != "${actual}" ]; then
		echo "(!) checksum mismatch for $1: expected '$2', got '${actual}'." >&2
		exit 1
	fi
}

# ---------------------------------------------------------------------------
# gh
# ---------------------------------------------------------------------------
if ! command -v gh >/dev/null 2>&1; then
	gh_tar="gh_${GH_VERSION}_linux_${GH_ARCH}.tar.gz"
	gh_base="https://github.com/cli/cli/releases/download/v${GH_VERSION}"
	curl -fsSL -o "${TMP}/${gh_tar}" "${gh_base}/${gh_tar}"
	curl -fsSL -o "${TMP}/gh_checksums.txt" "${gh_base}/gh_${GH_VERSION}_checksums.txt"
	verify_sha256 "${TMP}/${gh_tar}" \
		"$(grep " ${gh_tar}\$" "${TMP}/gh_checksums.txt" | cut -d' ' -f1)"
	tar -xzf "${TMP}/${gh_tar}" -C "${TMP}"
	install -m 0755 "${TMP}/gh_${GH_VERSION}_linux_${GH_ARCH}/bin/gh" /usr/local/bin/gh
fi

# ---------------------------------------------------------------------------
# Node, installed PRIVATELY and deliberately not placed on PATH.
#
# The agent runs the repository's own builds and tests, so whatever Node the
# repository's devcontainer pins must be the one its sessions see. A worker
# Node on PATH would shadow it, and the symptom — a repo pinned to Node 18
# building against 22 — would look like a bug in the repository. So the worker
# addresses its interpreter by absolute path, and container-boot's `launch()`
# re-execs `process.execPath`, which keeps the child on this same private Node
# without it ever being resolvable as `node`.
#
# Alpine needs the musl build from unofficial-builds; nodejs.org ships glibc
# binaries only, and a glibc Node on musl fails at exec with "not found",
# which reads as a missing file rather than a missing libc.
# ---------------------------------------------------------------------------
if [ "${FAMILY}" = "alpine" ]; then
	node_tar="node-v${NODE_VERSION}-linux-${NODE_ARCH}-musl.tar.xz"
	node_base="https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}"
else
	node_tar="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
	node_base="https://nodejs.org/dist/v${NODE_VERSION}"
fi
curl -fsSL -o "${TMP}/${node_tar}" "${node_base}/${node_tar}"
curl -fsSL -o "${TMP}/SHASUMS256.txt" "${node_base}/SHASUMS256.txt"
verify_sha256 "${TMP}/${node_tar}" \
	"$(grep " ${node_tar}\$" "${TMP}/SHASUMS256.txt" | cut -d' ' -f1)"
mkdir -p "${NODE_HOME}"
tar -xJf "${TMP}/${node_tar}" -C "${NODE_HOME}" --strip-components=1

# ---------------------------------------------------------------------------
# The worker itself.
#
# The Dockerfile COPYs a `pnpm deploy` tree out of a build stage. A Feature is
# an OCI artifact holding only its own files and cannot COPY from a build stage
# of this monorepo, so the payload has to arrive over the network as a tarball.
#
# `tarball` is the PRIMARY mechanism, not an escape hatch. `cyrus-ai` on the
# public npm registry is a different, older CLI: 0.2.70 ships 21 dist files, no
# `buildProgram`, and no `container-boot` command at all. Installing it produces
# an image that builds cleanly and then dies at boot with `error: too many
# arguments for 'start'` — the argument parser treating `container-boot` as a
# positional to `start`, which names neither the missing command nor the wrong
# package. `version` is kept for a deployment whose registry genuinely
# publishes this worker, and the assertion below is what makes the difference
# a BUILD failure instead of that runtime riddle.
# ---------------------------------------------------------------------------
# The tarball is EXTRACTED, never `npm install`ed. It is a `pnpm deploy` tree,
# whose package.json still declares nine `workspace:*` dependencies and sets no
# bundledDependencies — npm would try to resolve those from a registry and fail,
# after discarding the node_modules the tree already carries. Extracting keeps
# the tree exactly as `pnpm deploy --prod --legacy` produced it, which is what
# the Dockerfile COPYs today.
if [ -n "${TARBALL}" ]; then
	curl -fsSL -o "${TMP}/worker.tgz" "${TARBALL}"
	mkdir -p "${WORKER_HOME}/app"
	tar -xzf "${TMP}/worker.tgz" -C "${WORKER_HOME}/app" --strip-components=1
	APP_PATH="${WORKER_HOME}/app/dist/src/app.js"
	WORKER_SPEC="${TARBALL}"
else
	"${NODE_BIN}" "${NODE_HOME}/lib/node_modules/npm/bin/npm-cli.js" \
		install -g --prefix "${WORKER_HOME}" "cyrus-ai@${VERSION}"
	rm -rf /root/.npm
	APP_PATH="${WORKER_HOME}/lib/node_modules/cyrus-ai/dist/src/app.js"
	WORKER_SPEC="cyrus-ai@${VERSION}"
fi

if [ ! -f "${APP_PATH}" ]; then
	echo "(!) worker payload (${WORKER_SPEC}) installed but ${APP_PATH} is missing." >&2
	exit 1
fi
if ! "${NODE_BIN}" "${APP_PATH}" --help 2>&1 | grep -q 'container-boot'; then
	echo "(!) The worker payload (${WORKER_SPEC}) has no 'container-boot' command," >&2
	echo "    so it cannot boot a Cyrus worker. Set the 'tarball' option to a" >&2
	echo "    'pnpm deploy' tree built from this repository." >&2
	exit 1
fi

# `cyrus` on PATH as a shim rather than npm's bin symlink: the symlink resolves
# through the package's `#!/usr/bin/env node` shebang, which would pick up the
# REPOSITORY's node — the one thing the private install above exists to avoid.
printf '#!/bin/sh\nexec %s %s "$@"\n' "${NODE_BIN}" "${APP_PATH}" >/usr/local/bin/cyrus
chmod 0755 /usr/local/bin/cyrus

printf '#!/bin/sh\nexec %s %s container-boot\n' "${NODE_BIN}" "${APP_PATH}" >/entrypoint.sh
chmod 0755 /entrypoint.sh

# The worker tree stays root-OWNED — the agent has no business writing to its
# own runtime — but must be world-readable and world-traversable, because the
# process that reads it runs as the non-root user. Everything here was created
# by root under whatever umask the base image set, and a hardened base setting
# 077 would produce a tree only root can read: the container would then fail at
# exec with a permission error on a path that visibly exists. Same reason the
# fleece-cli Feature does this to its --tool-path.
chmod -R a+rX "${WORKER_HOME}"

# ---------------------------------------------------------------------------
# The worker user and the paths it owns.
#
# Created here rather than assumed, and created EARLY relative to the toolchain
# features: rust/node/github-cli all resolve `_REMOTE_USER` and fall back to
# `USERNAME=root` when `id -u` fails, which silently produces a CARGO_HOME and
# an NVM_DIR the agent cannot write to. The build pipeline must therefore list
# this feature first in `overrideFeatureInstallOrder`.
# ---------------------------------------------------------------------------
# /etc/group and /etc/passwd are read directly rather than through `getent`,
# which on Alpine lives in `musl-utils` and is not guaranteed present. The rust
# Feature greps /etc/group for the same reason.
if ! grep -q "^${USERNAME}:" /etc/group 2>/dev/null; then
	if [ "${FAMILY}" = "alpine" ]; then
		addgroup -g "${USER_GID}" "${USERNAME}" 2>/dev/null || addgroup "${USERNAME}"
	else
		groupadd -g "${USER_GID}" "${USERNAME}" 2>/dev/null || groupadd "${USERNAME}"
	fi
fi
if ! id -u "${USERNAME}" >/dev/null 2>&1; then
	if [ "${FAMILY}" = "alpine" ]; then
		adduser -D -u "${USER_UID}" -G "${USERNAME}" "${USERNAME}" 2>/dev/null ||
			adduser -D -G "${USERNAME}" "${USERNAME}"
	else
		useradd --create-home --uid "${USER_UID}" --gid "${USERNAME}" "${USERNAME}" 2>/dev/null ||
			useradd --create-home --gid "${USERNAME}" "${USERNAME}"
	fi
fi

USER_HOME="$(grep "^${USERNAME}:" /etc/passwd | cut -d: -f6)"
if [ -z "${USER_HOME}" ]; then
	echo "(!) could not resolve a home directory for ${USERNAME}." >&2
	exit 1
fi
# $HOME must be writable before anything else: container-boot writes its boot
# log there (BOOT_LOG_PATH), and that log is the only record of a boot failure
# that happens before the router's log relay attaches.
mkdir -p "${WORKSPACES_DIR}" "${REPO_CACHE_DIR}" "${USER_HOME}"
chown -R "${USERNAME}:${USERNAME}" "${WORKSPACES_DIR}" "${REPO_CACHE_DIR}" "${USER_HOME}"

echo "cyrus-worker installed: node ${NODE_VERSION} at ${NODE_BIN}, worker at ${APP_PATH}, user ${USERNAME}."
