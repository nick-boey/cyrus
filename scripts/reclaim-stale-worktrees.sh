#!/usr/bin/env bash
set -euo pipefail

# Reclaim disk from Cyrus worktrees left behind by closed issues.
#
# Cyrus normally removes an issue's worktree when the issue reaches a terminal
# state. Router-connected nodes running a version before the terminal-state
# forwarding fix never received that signal, so their worktrees accumulated
# (each one carrying its own node_modules / build output). This script cleans
# up that backlog.
#
# It is DRY-RUN by default: it prints what it would remove and why, and changes
# nothing until you pass --apply.
#
# Safety rules — a worktree is SKIPPED unless it is provably safe to delete:
#   * a process is currently working inside it (an active Cyrus session)
#   * it has uncommitted changes
#   * it has commits not present on its upstream branch
#   * it has no upstream branch at all (nothing to recover it from)
# Pass --force to override the git-safety rules (uncommitted / unpushed work is
# then permanently destroyed). --force never overrides the active-session check.
#
# Usage:
#   scripts/reclaim-stale-worktrees.sh                       # dry run, ~/.cyrus-node
#   scripts/reclaim-stale-worktrees.sh --apply               # actually remove
#   scripts/reclaim-stale-worktrees.sh --home ~/.cyrus       # another Cyrus home
#   scripts/reclaim-stale-worktrees.sh --apply --only PAR-99,PAR-98
#   scripts/reclaim-stale-worktrees.sh --apply --force       # ignore git safety

CYRUS_HOME="${CYRUS_HOME:-$HOME/.cyrus-node}"
APPLY=false
FORCE=false
ONLY=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply) APPLY=true; shift ;;
    --force) FORCE=true; shift ;;
    --home) CYRUS_HOME="$2"; shift 2 ;;
    --only) ONLY="$2"; shift 2 ;;
    -h|--help) sed -n '3,32p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown argument: $1 (try --help)" >&2; exit 1 ;;
  esac
done

WORKTREES_DIR="${CYRUS_HOME}/worktrees"
if [[ ! -d "${WORKTREES_DIR}" ]]; then
  echo "No worktrees directory at ${WORKTREES_DIR} — nothing to do."
  exit 0
fi

# Working directories of every running process, so we never delete a worktree
# out from under a live Cyrus session. lsof's `-d cwd` reads only the cwd
# descriptor (no directory recursion), so this stays fast; on Linux we can fall
# back to /proc when lsof isn't installed.
collect_active_cwds() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' || true
  elif [[ -d /proc ]]; then
    for p in /proc/[0-9]*; do
      readlink "${p}/cwd" 2>/dev/null || true
    done
  fi
}
ACTIVE_CWDS="$(collect_active_cwds)"

is_active() {
  local wt="$1"
  # Active if any process's cwd IS the worktree or sits underneath it.
  grep -qxF "${wt}" <<<"${ACTIVE_CWDS}" && return 0
  grep -q "^${wt}/" <<<"${ACTIVE_CWDS}" && return 0
  return 1
}

removed=0
skipped=0
declare -a PARENT_REPOS=()

echo "Cyrus home:      ${CYRUS_HOME}"
echo "Worktrees:       ${WORKTREES_DIR}"
echo "Mode:            $([[ "${APPLY}" == true ]] && echo APPLY || echo 'DRY RUN (use --apply to remove)')"
[[ "${FORCE}" == true ]] && echo "Force:           ON (uncommitted/unpushed work will be destroyed)"
echo

for path in "${WORKTREES_DIR}"/*; do
  [[ -d "${path}" ]] || continue
  issue="$(basename "${path}")"

  if [[ -n "${ONLY}" ]] && ! grep -qx "${issue}" <<<"$(tr ',' '\n' <<<"${ONLY}")"; then
    continue
  fi

  size="$(du -sh "${path}" 2>/dev/null | cut -f1)"

  if is_active "${path}"; then
    echo "SKIP  ${issue} (${size}) — a process is working in this worktree (active session)"
    skipped=$((skipped + 1))
    continue
  fi

  if [[ "${FORCE}" != true ]] && git -C "${path}" rev-parse --git-dir >/dev/null 2>&1; then
    if [[ -n "$(git -C "${path}" status --porcelain 2>/dev/null)" ]]; then
      echo "SKIP  ${issue} (${size}) — uncommitted changes (--force to override)"
      skipped=$((skipped + 1))
      continue
    fi
    upstream="$(git -C "${path}" rev-parse --abbrev-ref '@{u}' 2>/dev/null || true)"
    if [[ -z "${upstream}" ]]; then
      echo "SKIP  ${issue} (${size}) — no upstream branch; commits exist only here (--force to override)"
      skipped=$((skipped + 1))
      continue
    fi
    ahead="$(git -C "${path}" rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)"
    if [[ "${ahead}" != "0" ]]; then
      echo "SKIP  ${issue} (${size}) — ${ahead} commit(s) not pushed to ${upstream} (--force to override)"
      skipped=$((skipped + 1))
      continue
    fi
  fi

  # Resolve the parent repo now, while the worktree's .git file still exists,
  # so we can prune its stale admin entries after removal.
  parent="$(git -C "${path}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -n "${parent}" ]]; then
    parent="$(dirname "${parent}")" # strip trailing /.git
    PARENT_REPOS+=("${parent}")
  fi

  if [[ "${APPLY}" != true ]]; then
    echo "WOULD REMOVE  ${issue} (${size})"
    removed=$((removed + 1))
    continue
  fi

  echo "REMOVING  ${issue} (${size})"
  if [[ -n "${parent}" ]]; then
    git -C "${parent}" worktree remove --force "${path}" 2>/dev/null || true
  fi
  # git worktree remove can fail (e.g. already-corrupt admin data); the point of
  # this script is reclaiming disk, so delete the directory either way and prune
  # the stale entry afterwards.
  rm -rf "${path}"
  removed=$((removed + 1))
done

if [[ "${APPLY}" == true && ${#PARENT_REPOS[@]} -gt 0 ]]; then
  echo
  for repo in $(printf '%s\n' "${PARENT_REPOS[@]}" | sort -u); do
    echo "Pruning stale worktree entries in ${repo}"
    git -C "${repo}" worktree prune || true
  done
fi

echo
if [[ "${APPLY}" == true ]]; then
  echo "Removed ${removed} worktree(s), skipped ${skipped}."
  echo "Disk now: $(du -sh "${CYRUS_HOME}" 2>/dev/null | cut -f1) in ${CYRUS_HOME}"
else
  echo "Would remove ${removed} worktree(s), skipping ${skipped}. Re-run with --apply to do it."
fi
