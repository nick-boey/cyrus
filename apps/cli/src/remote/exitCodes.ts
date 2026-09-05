/**
 * The exit categories every remote-operator command reports (ADR 0011).
 *
 * This is the one place the numbers are written down. An orchestrating agent
 * branches on the code rather than parsing the prose, so changing what a code
 * means silently changes what every skill and CI job built on them concludes —
 * which is why {@link RemoteOperatorError} carries its category as a property of
 * the ERROR rather than of whichever call site happens to catch it.
 *
 * The distinctions that cost the most to get wrong:
 *
 * - `timeout` is THIS COMMAND's condition going unmet. A worker-reported
 *   `waiting` run is an observed `outcome`, not a timeout — collapsing the two
 *   is what makes an orchestrator retry a run that is asking it a question.
 * - `auth` is separate from `transient` because retrying an unauthorized
 *   request is pure noise against the router, and an orchestrator that cannot
 *   tell them apart will do exactly that.
 * - `outcome` covers a VALID non-success answer. A defect in this CLI is none
 *   of these categories; see {@link exitCodeFor}.
 */
export const ExitCode = {
	/** Success, or a satisfied wait condition. */
	success: 0,
	/** Invalid invocation, invalid configuration, or an unsupported capability. */
	usage: 2,
	/** A valid non-success run outcome, or a refused recovery. */
	outcome: 3,
	/** The command's own wait condition was not met in time. */
	timeout: 4,
	/** Authentication or authorization failure. */
	auth: 5,
	/** A transient router or log-source failure. */
	transient: 6,
} as const;

export type ExitCodeName = keyof typeof ExitCode;
export type ExitCodeValue = (typeof ExitCode)[ExitCodeName];

/**
 * The category a thrown value should exit with, or `undefined` when it has
 * none.
 *
 * Returning `undefined` rather than defaulting is the whole point: a bug
 * reported as `6` tells an operator to retry a command that will never succeed,
 * so anything not derived from `RemoteOperatorError` must be re-thrown and
 * surface as the crash it is.
 *
 * The check is structural rather than an `instanceof RemoteOperatorError` so
 * that this module imports nothing — `errors.ts` depends on the constants here,
 * and a cycle between the two would make module-initialisation order decide
 * whether an exit code is defined. `Error` plus a code from the closed set is
 * narrow enough: nothing else in this codebase carries one of these six.
 */
export function exitCodeFor(error: unknown): ExitCodeValue | undefined {
	if (!(error instanceof Error)) return undefined;
	const code = (error as { exitCode?: unknown }).exitCode;
	return typeof code === "number" &&
		(Object.values(ExitCode) as number[]).includes(code)
		? (code as ExitCodeValue)
		: undefined;
}
