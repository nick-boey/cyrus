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

/** Items past this are collapsed into a `+N more` marker — see
 *  {@link formatPendingWorkSummary}. */
const MAX_SUMMARY_ITEMS = 20;

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
 * ── IDENTITY AND STRUCTURE ONLY, NEVER CONTENT ──
 * Every field here is an id, an enum-like label or a schedule. The free-text
 * ones the SDK also offers — `cron.prompt`, `task.description` and especially
 * `task.command`, which is documented as the shell command line — are
 * deliberately NOT included. This string is an attribute on
 * `session.terminal_deferred`, which is an `event` and therefore bypasses the
 * sink's level threshold and leaves the sandbox; a backgrounded command line is
 * exactly the shape that carries credentials in argv (`curl -H "Authorization:
 * Bearer …"`, `PGPASSWORD=… psql`), and a secret that reaches a telemetry
 * backend is disclosed. It would also have been the first Cyrus event to carry
 * a payload at all: the pre-existing `session.pending_work_recorded` and
 * `session.background_tasks_changed` both carry counts only.
 *
 * The ids are what make that sufficient. Each one appears in the session's own
 * Linear timeline, so an operator can correlate from here without the content
 * ever being exported.
 *
 * Length is capped for the same reason: the transports clip an attribute at
 * 512/1000 chars, but `Logger.forwardEvent` passes the merged attributes
 * straight to the error reporter with no truncation at all, so a session
 * holding hundreds of tasks would ship an unbounded string to a second billed
 * backend.
 *
 * Never returns null: this is only called when something IS pending.
 */
export function formatPendingWorkSummary(
	pendingWork: AgentPendingWork,
): string {
	const items = [
		...pendingWork.sessionCrons.map(
			(cron) =>
				`cron(${cron.id} ${cron.recurring ? "recurring" : "once"} ${cron.schedule})`,
		),
		...pendingWork.backgroundTasks.map(
			(task) => `background(${task.id} ${task.type}/${task.status})`,
		),
		...(pendingWork.liveBackgroundTasks ?? []).map(
			(task) => `live-background(${task.taskId} ${task.taskType})`,
		),
	];
	if (items.length === 0) return "unspecified pending work";
	if (items.length <= MAX_SUMMARY_ITEMS) return items.join("; ");
	const shown = items.slice(0, MAX_SUMMARY_ITEMS);
	return `${shown.join("; ")}; +${items.length - MAX_SUMMARY_ITEMS} more`;
}

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

function truncate(text: string, max: number): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}
