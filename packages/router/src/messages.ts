/**
 * User-facing activity bodies the {@link EventRouter} posts to a Linear agent
 * session. Kept in one place so the routing logic and its tests share the exact
 * same strings.
 */

/**
 * Posted when a session's creator has no enrolled Cyrus device to route to.
 *
 * Templated with `{{userName}}` — render with {@link fillTemplate} before
 * posting. Intentionally NOT the removed `DEFAULT_UNREGISTERED_USER_MESSAGE`:
 * this describes the router enrollment flow (`cyrus router users add` +
 * `cyrus connect`), not the deleted `cyrus users add` flow.
 */
export const UNENROLLED_CREATOR_MESSAGE = `Hi {{userName}},

I can't pick up this issue yet: your Linear account isn't linked to an enrolled Cyrus device, so there's no machine for me to run on.

To get set up:
1. Ask your Cyrus admin to run \`cyrus router users add <your-email>\` and share the enrollment code with you.
2. On your own machine, run \`cyrus connect <router-url> --code <code>\`.

Once your device is connected, re-delegate this issue and I'll get started.`;

/**
 * Posted when a container-executor user's issue key fails the container
 * workspace's identifier gate (`ContainerTargetService`'s `ISSUE_KEY_RE`).
 * Distinct from {@link UNENROLLED_CREATOR_MESSAGE}: the user IS enrolled with
 * a container executor — it's this particular issue's identifier that can't
 * name a workspace/container, so telling them to ask an admin to enroll them
 * (the unenrolled message) would send them chasing the wrong problem.
 *
 * Templated with `{{issueKey}}` — render with {@link fillTemplate} before
 * posting.
 */
export const INVALID_ISSUE_KEY_MESSAGE = `I can't start a container workspace for this issue: its identifier ({{issueKey}}) can't be used to name one.

This is unusual — Linear issue identifiers are normally safe for this. An operator should check the router logs for the exact key that was rejected.`;

/** Posted when an issue is already locked by another user's session. */
export const ISSUE_LOCKED_MESSAGE =
	"An agent is already working on this issue (session owned by another user). Try again when it finishes.";

/**
 * Posted when a prompt arrives for a session we cannot route to any device:
 * no session affinity, no enrolled device for the creator, and no issue
 * affinity. Without this the prompt was dropped silently and the Linear agent
 * session sat in "Waiting for Cyrus" forever.
 */
export const PROMPT_UNROUTABLE_MESSAGE =
	"I can't pick this up: there's no enrolled Cyrus device associated with this session any more. Please re-delegate the issue to start a fresh session.";

/**
 * Posted when creator-only prompting is enabled and a non-creator tries to
 * prompt someone else's session.
 */
export const PROMPT_REJECTION_MESSAGE =
	"Only the person who started this session can send it new instructions. Please start your own session if you'd like to delegate this issue.";

/** Posted once per session when the target device is offline and we queue. */
export function offlineWaitingMessage(email: string): string {
	return `Waiting for ${email}'s machine to come online. This session will start when their Cyrus device reconnects.`;
}

/** Posted when a queued event expires before the device reconnected. */
export function expiredMessage(email: string): string {
	return `This request expired before ${email}'s machine came online. Please re-delegate the issue.`;
}

/** Posted when a stale lock is released because its device stayed dark. */
export function offlineReleaseMessage(email: string): string {
	return `Released this issue's lock: ${email}'s machine has been offline past the event TTL.`;
}

/**
 * Posted when a container-executor user's per-issue container fails to boot
 * (`ContainerExecutor.ensureRunning` rejected). Posted once per issue until a
 * boot succeeds — a cold boot itself is expected and NOT what this message is
 * for; only an actual failure is.
 */
export const CONTAINER_BOOT_FAILED_MESSAGE =
	"I couldn't start the workspace container for this issue ({{issueKey}}): {{detail}}. An operator should check the router logs; I'll retry on the next prompt.";
export function containerBootFailedMessage(
	issueKey: string,
	detail: string,
): string {
	return fillTemplate(CONTAINER_BOOT_FAILED_MESSAGE, { issueKey, detail });
}

/**
 * Posted when a device reconnects and no longer tracks a session whose issue
 * lock it still held — i.e. the device lost the session (typically to a
 * corrupted state file) and can never report it terminal. Releasing the lock
 * lets the issue be re-delegated.
 */
export const ORPHANED_LOCK_RECLAIMED_MESSAGE =
	"Released this issue's lock: the agent's device no longer has this session (its state was lost on restart). Re-delegate the issue to start a fresh session.";

/** Body of the repository-selection elicitation the router posts. */
export const REPOSITORY_SELECTION_PROMPT =
	"Which repository should I work in for this issue?";

/**
 * Posted when a `created` event cannot be routed to any repository because
 * none are registered for the workspace, or the registry could not be read.
 *
 * Templated with `{{reason}}` — render with {@link fillTemplate} before posting.
 */
export const NO_REPOSITORIES_MESSAGE = `I can't start work on this issue yet: {{reason}}

Once a repository is registered, re-assign this issue (or mention me again) and I'll pick it up.`;

/**
 * Posted when {@link EventRouter.sweepExpired}'s repository-selection pass
 * gives up on a selection nobody ever answered (past `eventTtlMs`, same bound
 * as the queued-event expiry pass). Without this the held delegation just
 * vanishes with no notice — a user answering days later would have their
 * reply delivered as an ordinary prompt to a session that was never created.
 */
export const REPOSITORY_SELECTION_EXPIRED_MESSAGE =
	"I stopped waiting for a repository choice on this issue. Re-assign it (or mention me again) to pick a repository and start fresh.";

/**
 * Replaces `{{key}}` placeholders in `template` with the matching value from
 * `vars`. Unknown placeholders are left intact.
 */
export function fillTemplate(
	template: string,
	vars: Record<string, string>,
): string {
	return template.replace(
		/\{\{(\w+)\}\}/g,
		(_match, key: string) => vars[key] ?? `{{${key}}}`,
	);
}

/**
 * Posted when an issue's repository declares its own devcontainer and the image
 * for it is not built yet.
 *
 * The `created` event is held while this build runs, so nothing boots — which
 * means this notice is the ONLY thing the user sees for what can be several
 * minutes. A "Building…" that never visibly resolves is the same debugging
 * problem as saying nothing at all, which is why the two messages below always
 * follow it.
 */
export const DEVCONTAINER_BUILDING_MESSAGE = `Building the workspace image for {{repository}} from its devcontainer. This takes a few minutes the first time, and is cached afterwards — I'll start as soon as it's ready.`;

export const DEVCONTAINER_READY_MESSAGE =
	"The workspace image for {{repository}} is ready. Starting now.";

/**
 * `{{runId}}` is the load-bearing half of this message (ADR 0006): the build ran
 * with unrestricted egress over repository-controlled content, so the log is
 * behind Azure's own authorization and this id is what makes
 * `az acr task logs --run-id` possible for someone allowed to read it.
 */
export const DEVCONTAINER_BUILD_FAILED_MESSAGE = `I couldn't build the workspace image for {{repository}} from its devcontainer, so I'm using the default environment instead — the toolchains that devcontainer asks for may be missing.

{{detail}}`;

/**
 * Posted when an issue spans several repositories, which the plan's Task 8
 * leaves as an open question.
 *
 * The default worker image is the plan's own recommended answer for this case:
 * it is the only image carrying every toolchain, and a deliberate multi-repo
 * fan-out is exactly the polyglot case. What the user gives up is named
 * explicitly, because choosing silently is what makes a missing toolchain look
 * like a Cyrus bug rather than a consequence of the fan-out.
 */
export const DEVCONTAINER_MULTI_REPO_MESSAGE = `This issue spans several repositories ({{repositories}}), so I'm using the default environment rather than any one repository's devcontainer. It carries every toolchain Cyrus knows about, but not the specific versions those devcontainers pin.`;
