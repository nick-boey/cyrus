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

/** Posted when an issue is already locked by another user's session. */
export const ISSUE_LOCKED_MESSAGE =
	"An agent is already working on this issue (session owned by another user). Try again when it finishes.";

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
