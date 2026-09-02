#!/usr/bin/env bash
# NOR-309 Task 0 spike — build the devcontainer expression of the worker image
# and check the boot contract against it.
#
# Run this on a host with Docker. EXECUTED 2026-09-01 on Docker 29.7.2
# (darwin/arm64): all 23 boot-contract assertions pass, `devcontainer build`
# takes 205s and produces a 7.76 GB image. See the spike document for the two
# findings that only a real build could produce.
#
#   ./docker/worker/devcontainer/build.sh
#
# CYRUS_WORKER_TARBALL must point at a worker payload built from this
# repository. It is not optional: `cyrus-ai` on public npm is a different,
# older CLI with no `container-boot` command (verified: 0.2.70).
#
# It must be a gzipped `pnpm deploy` tree, NOT an `npm pack`. cyrus-ai declares
# nine `workspace:*` dependencies, so a packed tarball is unresolvable from any
# registry; the deploy tree carries its own node_modules and is what the
# Dockerfile COPYs today. Produce one with:
#
#   pnpm build
#   pnpm --filter cyrus-ai deploy --prod --legacy /tmp/out
#   tar -czf /tmp/worker.tgz -C /tmp out          # ~256 MB
#   export CYRUS_WORKER_TARBALL=file:///tmp/worker.tgz
#
# curl accepts file:// as well as http(s)://.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGE_BUILT="${IMAGE_BUILT:-cyrus-worker-devcontainer:built}"
IMAGE_FINAL="${IMAGE_FINAL:-cyrus-worker-devcontainer:final}"
WORKER_USER="${WORKER_USER:-cyrus}"

if ! command -v devcontainer >/dev/null 2>&1; then
	echo "devcontainer CLI not found: npm install -g @devcontainers/cli" >&2
	exit 1
fi

if [ -z "${CYRUS_WORKER_TARBALL:-}" ]; then
	echo "CYRUS_WORKER_TARBALL is unset — see the header of this script." >&2
	exit 1
fi
export CYRUS_WORKER_TARBALL

# The cyrus-worker Feature lives at features/src/cyrus-worker so Task 2 can
# publish it from the canonical layout. The CLI refuses local feature paths
# that escape the .devcontainer folder, so stage a copy rather than symlinking
# (the CLI tars the folder, and a dangling symlink inside that tar is a much
# worse failure than a stale copy).
rm -rf "${HERE}/.devcontainer/features/cyrus-worker"
cp -R "${HERE}/../../../features/src/cyrus-worker" \
	"${HERE}/.devcontainer/features/cyrus-worker"

echo "==> devcontainer build"
SECONDS=0
# --buildkit never is not a performance choice. `devcontainer build` shells out
# to the daemon, and a recent buildx attaches provenance/SBOM attestations by
# default, which makes the result an OCI image INDEX. The ACA disk importer
# cannot consume one — scripts/deploy-worker-image.sh gates on the manifest
# media type for exactly this reason. Classic docker build yields the plain
# Docker v2 manifest the import needs. The alternative, if BuildKit is wanted,
# is `--output` carrying `--provenance=false --sbom=false`.
#
# Platform is left native by default: the ACR agent is amd64 already, and
# cross-building an image this size under emulation on an arm64 workstation is
# the difference between minutes and tens of minutes.
devcontainer build \
	--workspace-folder "${HERE}" \
	--image-name "${IMAGE_BUILT}" \
	--buildkit never \
	${BUILD_PLATFORM:+--platform "${BUILD_PLATFORM}"}
echo "==> devcontainer build finished in ${SECONDS}s"

echo "==> applying USER/ENTRYPOINT (the two instructions the CLI cannot emit)"
docker build \
	--build-arg "BUILT_IMAGE=${IMAGE_BUILT}" \
	--build-arg "WORKER_USER=${WORKER_USER}" \
	-f "${HERE}/Dockerfile.finalize" \
	-t "${IMAGE_FINAL}" \
	"${HERE}"

echo "==> size"
docker image inspect "${IMAGE_FINAL}" --format '{{.Size}}' |
	awk '{printf "%.2f GB\n", $1/1000/1000/1000}'

# --- boot contract ---------------------------------------------------------
# Each of these is something docker/worker/Dockerfile guarantees by owning the
# whole image, and that the Feature has to re-establish on a base that knows
# nothing about Cyrus. A pass here is the spike's success criterion.
echo "==> boot contract"
fail=0
check() {
	if docker run --rm --entrypoint sh "${IMAGE_FINAL}" -c "$2" >/dev/null 2>&1; then
		echo "  ok    $1"
	else
		echo "  FAIL  $1"
		fail=1
	fi
}

check "runs as non-root ${WORKER_USER}" "[ \"\$(id -un)\" = ${WORKER_USER} ]"
check "/entrypoint.sh is executable" "[ -x /entrypoint.sh ]"
check "/workspaces writable by the worker user" "touch /workspaces/.probe && rm /workspaces/.probe"
check "/var/cache/repos writable" "touch /var/cache/repos/.probe && rm /var/cache/repos/.probe"
check "\$HOME writable (BOOT_LOG_PATH)" "touch \"\$HOME/.probe\" && rm \"\$HOME/.probe\""
check "git present" "command -v git"
check "gh present" "command -v gh"
check "curl present" "command -v curl"
check "jq present" "command -v jq"
check "ca-certificates present" "[ -s /etc/ssl/certs/ca-certificates.crt ]"
check "cyrus shim on PATH" "command -v cyrus"
check "container-boot is a registered command" "cyrus --help | grep -q container-boot"
# The toolchains, as the NON-ROOT user — the question the Dockerfile's
# --tool-path / RUSTUP_HOME / chown workarounds exist to answer.
check "dotnet usable" "dotnet --version"
check "pwsh usable" "pwsh -Version"
check "fleece on PATH" "command -v fleece || ls /usr/local/dotnet-tools"
check "cargo usable" "cargo --version"
check "CARGO_HOME writable (cargo writes its registry cache)" \
	"touch \"\${CARGO_HOME:-/usr/local/cargo}/.probe\" && rm \"\${CARGO_HOME:-/usr/local/cargo}/.probe\""
check "rustfmt + clippy present" "cargo fmt --version && cargo clippy --version"
check "actionlint usable" "actionlint --version"
check "codex on PATH" "command -v codex"
check "opencode on PATH" "command -v opencode"
check "chromium present" "ls /ms-playwright"
check "/ms-playwright writable (repo may pin another revision)" \
	"touch /ms-playwright/.probe && rm /ms-playwright/.probe"

# The real thing: the entrypoint must reach container-boot's env validation.
# Reaching "Missing required environment variable(s)" means the whole chain —
# private node, app path, argv, command registration — is intact.
echo "==> entrypoint reaches container-boot"
# `container-boot` exits NON-ZERO here — that is the success condition, not a
# failure: it validated its environment and refused to start. Under `pipefail`
# the pipeline's status is the docker run's, so the grep must be evaluated on
# captured output rather than through a pipe, or a passing check reads as FAIL.
entrypoint_out="$(docker run --rm "${IMAGE_FINAL}" 2>&1 || true)"
if printf '%s' "${entrypoint_out}" | grep -q 'Missing required environment variable'; then
	echo "  ok    /entrypoint.sh reaches container-boot's env validation"
else
	echo "  FAIL  /entrypoint.sh did not reach container-boot"
	printf '%s\n' "${entrypoint_out}" | tail -20
	fail=1
fi

exit "${fail}"
