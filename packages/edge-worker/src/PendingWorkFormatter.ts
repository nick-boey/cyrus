import type {
	AgentPendingWork,
	BackgroundTaskSummary,
	SessionCronSummary,
} from "cyrus-core";

/**
 * Formatting helpers for sessions that end a turn with work still scheduled
 * or in flight (ScheduleWakeup/CronCreate timers, backgrounded tasks).
 *
 * Two pieces work together to keep Linear's agent panel honest:
 *  1. `formatScheduleWakeupResponse` — when the agent's final message before
 *     `result` was a bare ScheduleWakeup tool call, the buffered "response"
 *     content is the raw tool-input JSON. Replace it with readable prose.
 *  2. `formatPendingWorkThought` — posted as a `thought` AFTER the response
 *     activity, which flips the Linear panel back into its working state and
 *     declares what the session is waiting on.
 */

/** Shape of the ScheduleWakeup tool input (mirrors the SDK's tool schema). */
interface ScheduleWakeupInput {
	delaySeconds: number;
	reason?: string;
	prompt?: string;
}

/**
 * Try to parse a buffered response body as a raw ScheduleWakeup tool-input
 * JSON (`{"delaySeconds": ..., "reason": ..., "prompt": ...}`). Returns null
 * when the content is anything else (real prose, other tools, invalid JSON).
 */
export function tryParseScheduleWakeupInput(
	content: string,
): { delaySeconds: number; reason?: string; prompt?: string } | null {
	const trimmed = content.trim();
	if (!trimmed.startsWith("{")) return null;
	try {
		const parsed = JSON.parse(trimmed) as Partial<ScheduleWakeupInput>;
		if (typeof parsed.delaySeconds !== "number") return null;
		return {
			delaySeconds: parsed.delaySeconds,
			...(typeof parsed.reason === "string" && { reason: parsed.reason }),
			...(typeof parsed.prompt === "string" && { prompt: parsed.prompt }),
		};
	} catch {
		return null;
	}
}

/**
 * Render a friendly Linear `response` body for a turn that ended on a
 * ScheduleWakeup call.
 */
export function formatScheduleWakeupResponse(input: {
	delaySeconds: number;
	reason?: string;
	prompt?: string;
}): string {
	const lines = [
		`⏰ **Wakeup scheduled** — resuming in ${formatDuration(input.delaySeconds)}.`,
	];
	if (input.reason) {
		lines.push("", `> ${input.reason}`);
	}
	return lines.join("\n");
}

/**
 * Render the `thought` body posted after the response, declaring everything
 * that will wake the session later. Returns null when nothing is pending so
 * callers can skip posting.
 */
export function formatPendingWorkThought(
	pendingWork: AgentPendingWork,
): string | null {
	const items = [
		...pendingWork.sessionCrons.map(formatSessionCron),
		...pendingWork.backgroundTasks.map(formatBackgroundTask),
	];
	if (items.length === 0) return null;

	return [
		"⏳ Standing by — this session will wake automatically:",
		"",
		...items.map((item) => `- ${item}`),
	].join("\n");
}

/**
 * A compact, single-line rendering of everything holding a session open, for
 * TELEMETRY rather than for Linear.
 *
 * Separate from {@link formatPendingWorkThought} because the two have different
 * jobs and, critically, different coverage. The thought is the user-visible
 * "standing by" message and deliberately lists only what will wake the session
 * on a schedule — crons and backgrounded tasks the Stop hook reported. It
 * returns null for a session held open ONLY by a live background task, because
 * there is nothing scheduled to tell the user about.
 *
 * That null is exactly wrong for the diagnostic, though: a background task that
 * never exits is the leading suspect for a session that never goes terminal
 * (NOR-402), so the one case an operator most needs named is the one the thought
 * cannot name. `liveBackgroundTasks` comes from the SDK's
 * `background_tasks_changed` level signal and is populated independently of the
 * Stop hook that fills the other two, so it has to be read separately.
 *
 * Never returns null: this is only called when something IS pending.
 *
 * Bounded at BOTH axes on purpose. Each item is truncated, and the item COUNT is
 * capped at {@link PENDING_WORK_SUMMARY_MAX_ITEMS} with a `+N more` suffix, so
 * the emitted value is bounded where it is produced rather than by whatever
 * clamp the sink downstream happens to apply (`RouterLogForwarder` truncates
 * attributes at 512 chars, `SandboxLogRelay` at 1000 — neither is this
 * function's contract, and a change to either would silently change what this
 * emits). This attribute goes to a per-GB backend on the highest-frequency
 * terminal path there is.
 */
export function formatPendingWorkSummary(
	pendingWork: AgentPendingWork,
): string {
	const items = [
		...(pendingWork.sessionCrons ?? []).map(
			(cron) =>
				`cron(${cron.recurring ? "recurring " : ""}${cron.schedule})` +
				(cron.prompt ? `: ${truncate(cron.prompt, 80)}` : ""),
		),
		...(pendingWork.backgroundTasks ?? []).map(
			(task) =>
				`background(${task.type}/${task.status}: ` +
				`${truncate(task.command ?? task.description, 80)})`,
		),
		...(pendingWork.liveBackgroundTasks ?? []).map(
			(task) =>
				`live-background(${task.taskType}: ${truncate(task.description, 80)})`,
		),
	];
	if (items.length === 0) return "unspecified pending work";
	if (items.length <= PENDING_WORK_SUMMARY_MAX_ITEMS) return items.join("; ");
	const shown = items.slice(0, PENDING_WORK_SUMMARY_MAX_ITEMS);
	return `${shown.join("; ")}; +${items.length - PENDING_WORK_SUMMARY_MAX_ITEMS} more`;
}

/**
 * How many pending-work items the telemetry summary names before collapsing the
 * rest into a count. Enough to diagnose a stuck session; short of letting a
 * runaway cron list become the log volume.
 */
export const PENDING_WORK_SUMMARY_MAX_ITEMS = 10;

function formatSessionCron(cron: SessionCronSummary): string {
	const when = cron.recurring
		? `on schedule \`${cron.schedule}\``
		: describeOneShotCronTime(cron.schedule);
	const prompt = cron.prompt ? ` — "${truncate(cron.prompt, 140)}"` : "";
	return cron.recurring
		? `🔁 Recurring wakeup ${when}${prompt}`
		: `⏰ Wakeup ${when}${prompt}`;
}

function formatBackgroundTask(task: BackgroundTaskSummary): string {
	const label = task.type === "shell" ? "Background command" : task.type;
	const detail = task.command
		? `\`${truncate(task.command, 100)}\``
		: truncate(task.description, 140);
	return `🛠️ ${capitalize(label)} (${task.status}): ${detail}`;
}

/**
 * One-shot ScheduleWakeup tasks encode their single fire time as a cron
 * expression ("27 12 * * *" = today at 12:27 local time). Render it as a
 * clock time when the expression has concrete minute/hour fields; fall back
 * to showing the raw expression otherwise.
 */
function describeOneShotCronTime(schedule: string): string {
	const fields = schedule.trim().split(/\s+/);
	if (fields.length >= 2) {
		const minute = Number(fields[0]);
		const hour = Number(fields[1]);
		if (
			Number.isInteger(minute) &&
			Number.isInteger(hour) &&
			minute >= 0 &&
			minute <= 59 &&
			hour >= 0 &&
			hour <= 23
		) {
			return `at ${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
		}
	}
	return `on schedule \`${schedule}\``;
}

function formatDuration(seconds: number): string {
	if (seconds < 90) return `~${Math.round(seconds)}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 90) return `~${minutes}m`;
	return `~${Math.round(minutes / 60)}h`;
}

/**
 * `text` is typed as `string` but is not always one at runtime: it comes from a
 * runner-supplied payload, and `task.command ?? task.description` yields
 * `undefined` for a background task carrying neither. This is called from
 * `completeSession`'s `finally`, where a TypeError would reject the terminal
 * path itself — the one path whose whole job is to release the router's issue
 * lock. Degrading to a placeholder is strictly better than that.
 */
function truncate(text: string | undefined, max: number): string {
	if (typeof text !== "string") return "(unnamed)";
	const collapsed = text.replace(/\s+/g, " ").trim();
	if (collapsed.length === 0) return "(unnamed)";
	return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
