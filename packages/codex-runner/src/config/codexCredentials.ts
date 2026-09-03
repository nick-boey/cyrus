import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The credential preflight Codex runs before its first request.
 *
 * Without it, an unauthenticated session is indistinguishable from a broken
 * one: Codex starts, sends its first turn, and the user is shown OpenAI's
 * transport-level rejection —
 * `401 Unauthorized: Missing bearer or basic authentication in header, url:
 * https://api.openai.com/v1/responses` — which names neither the cause (no
 * credential was ever delivered to this container) nor a remedy. That is the
 * failure CYR-79 was reported as.
 *
 * The check is deliberately filesystem-only and does not spawn `codex login
 * status`: the two credentials Codex can run on are exactly `OPENAI_API_KEY` in
 * the environment and `$CODEX_HOME/auth.json` on disk, and reading them
 * directly is both cheaper and deterministic — a subprocess that fails for an
 * unrelated reason (missing binary, a slow cold start hitting a timeout) would
 * turn into a fabricated auth error.
 *
 * It reports *absent* and *unusable*, never *expired*. A live access token
 * inside `auth.json` may legitimately be at or past its expiry — Codex refreshes
 * from the refresh token beside it — so treating a stale `exp` as fatal would
 * fail sessions that were about to work. An expired credential the router could
 * not refresh never reaches this point: the boot fails first, in
 * `ContainerTargets.attachCodexCredential`, with that error's own remedy.
 */

/** The auth material Codex will use, as far as a preflight can tell. */
export type CodexCredentialKind = "api-key" | "chatgpt-subscription";

export class CodexCredentialError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CodexCredentialError";
	}
}

const REMEDY = [
	'Connect a ChatGPT subscription in the "Codex account" section of the router\'s /setup page',
	"(run `codex login --device-auth` on your own machine and paste the resulting auth.json),",
	"or set OPENAI_API_KEY to run Codex on metered billing instead.",
].join(" ");

/**
 * Throws a {@link CodexCredentialError} naming the remedy when neither
 * credential is available; returns which one will be used otherwise.
 */
export function assertCodexCredentialAvailable(opts: {
	codexHome: string;
	env?: Record<string, string | undefined>;
}): CodexCredentialKind {
	const env = opts.env ?? process.env;
	if (env.OPENAI_API_KEY?.trim()) return "api-key";

	const authPath = join(opts.codexHome, "auth.json");
	let raw: string;
	try {
		raw = readFileSync(authPath, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			throw new CodexCredentialError(
				`Codex has no credential to authenticate with: OPENAI_API_KEY is unset and ${authPath} does not exist. ${REMEDY}`,
			);
		}
		throw new CodexCredentialError(
			`Codex could not read its credential at ${authPath}: ${(error as Error).message}. ${REMEDY}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new CodexCredentialError(
			`Codex's credential at ${authPath} is not valid JSON, so it cannot be used. ${REMEDY}`,
		);
	}

	const auth = parsed as {
		OPENAI_API_KEY?: unknown;
		tokens?: { access_token?: unknown; refresh_token?: unknown };
	} | null;
	if (typeof auth?.OPENAI_API_KEY === "string" && auth.OPENAI_API_KEY.trim()) {
		return "api-key";
	}
	// A refresh token alone is enough — Codex mints an access token from it. The
	// router normally supplies both.
	const accessToken = auth?.tokens?.access_token;
	const refreshToken = auth?.tokens?.refresh_token;
	if (
		(typeof accessToken === "string" && accessToken.trim()) ||
		(typeof refreshToken === "string" && refreshToken.trim())
	) {
		return "chatgpt-subscription";
	}

	throw new CodexCredentialError(
		`Codex's credential at ${authPath} contains neither an OpenAI API key nor ChatGPT subscription tokens, so it cannot be used. ${REMEDY}`,
	);
}
