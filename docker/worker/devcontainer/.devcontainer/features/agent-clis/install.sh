#!/bin/sh
# Mirrors docker/worker/Dockerfile's codex/opencode block. Both npm packages
# resolve their native binary through per-platform optionalDependencies, so a
# plain global install picks the right linux-x64/linux-arm64 build with no arch
# special-casing.
#
# Uses the base image's own npm, NOT the worker feature's private Node: these
# CLIs are for the agent's sessions, so they belong on the same runtime the
# repository's own tooling sees.
set -eu

CODEX_VERSION="${CODEXVERSION:-0.144.6}"
OPENCODE_VERSION="${OPENCODEVERSION:-1.18.13}"

if ! command -v npm >/dev/null 2>&1; then
	echo "(!) agent-clis requires npm on the base image or the node Feature." >&2
	exit 1
fi

npm install -g \
	"@openai/codex@${CODEX_VERSION}" \
	"opencode-ai@${OPENCODE_VERSION}"
rm -rf /root/.npm
