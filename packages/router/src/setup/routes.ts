import type { ILogger } from "cyrus-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CodexTokenStore } from "../CodexTokenStore.js";
import type { RouterStore } from "../RouterStore.js";
import {
	isLateReservedEnvKey,
	isReservedEnvKey,
	normalizeSecretKey,
	type SecretStoreBackend,
	type UserSecretBundle,
} from "../SecretStore.js";
import { SetupConflictError } from "../TableSecretStore.js";
import type { SetupBootstrap } from "./bootstrap.js";
import { CodexAuthValidationError, parseCodexAuthPaste } from "./codexAuth.js";
import type { CsrfTokens } from "./csrf.js";
import { BundleTooLargeError, MAX_BUNDLE_BYTES } from "./envelope.js";
import {
	DEFAULT_MAX_FORM_BODY_BYTES,
	FormBodyTooLargeError,
	parseFormBody,
} from "./formbody.js";
import {
	requireSetupPrincipal,
	type SetupAuthConfig,
	SetupAuthError,
	type SetupIdTokenVerifier,
	type SetupPrincipal,
	shouldRedirectToSetup,
} from "./principal.js";
import {
	encodeDefaultRunnerJson,
	parseSelection,
	resolveDefaultRunner,
} from "./runnerDefaults.js";
import { HTMX_JS } from "./vendor/htmx.js";
import { PICO_CSS } from "./vendor/pico.js";
import {
	escapeHtml,
	renderCodexSection,
	renderDefaultsSection,
	renderMessage,
	renderPage,
	renderVariablesTable,
	type SetupMessage,
	type SetupPageModel,
	type VariableView,
} from "./views.js";

/**
 * HTTP surface for the `/setup*` management UI.
 *
 * Three properties are load-bearing here and are each pinned by a test in
 * `test/setup-routes.test.ts`:
 *
 * 1. **`GET /setup` is genuinely read-only** (F18). Provisioning a user
 *    creates a SQLite row and a secret record, so doing it on GET meant a
 *    plain cross-site navigation could provision an account for any
 *    signed-in tenant user on a route that carries no CSRF token. It moved
 *    to {@link registerSetupRoutes}'s `POST /setup/provision`.
 * 2. **The record version is captured at RENDER time** (F8). `GET /setup`
 *    reads the record's ETag and embeds it as an opaque, principal-bound
 *    token; `POST /setup/save` performs its conditional write against THAT
 *    token. Reading the ETag inside the save handler instead would always
 *    yield the current value, so the advertised "two tabs, the second one
 *    409s" could essentially never fire.
 * 3. **No stored or submitted value is ever in a response** (D5′). Every
 *    response body is built from {@link views}, which renders `isSet`
 *    booleans and never a value — including on every error path.
 *
 * Delivery of the CSRF token is body-or-header only, never a query string
 * (F18): an 8-hour-lived token in a URL lands in access logs and browser
 * history.
 */

/**
 * Security headers for every `/setup*` HTML response.
 *
 * `script-src` deliberately carries `'unsafe-inline'` **and that is not the
 * relaxation it looks like**. {@link renderPage} emits a SECOND policy in a
 * `<meta>` tag carrying a fresh per-render nonce, and a script must satisfy
 * *every* delivered policy. A header policy of `script-src 'self'` would
 * therefore intersect the meta policy down to "no inline script at all" and
 * silently kill the `htmx:beforeSwap` handler that F12 exists to install —
 * a failure invisible to `inject()` tests, which never execute script.
 * `'unsafe-inline'` in this policy is ignored by any *other* policy that
 * specifies a nonce, so the effective rule for a full page remains
 * "nonce-matched inline scripts only".
 *
 * The pages this module renders itself (provision, error) carry no inline
 * script and ship their own strict `<meta>` policy, so they are not weakened.
 */
const CSP = [
	"default-src 'none'",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	// htmx posts /setup/save over XMLHttpRequest. XHR is governed by
	// `connect-src`, NOT `form-action` — that one only covers real form
	// submissions — so without this the request falls back to `default-src
	// 'none'` and every save is blocked while the page still renders fine.
	"connect-src 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
].join("; ");

/** The strict policy for the standalone pages rendered in this module. */
const STRICT_CSP = CSP.replace(
	"script-src 'self' 'unsafe-inline'",
	"script-src 'self'",
);

const VALUE_PREFIX = "value:";
const CLEAR_PREFIX = "clear:";

/**
 * Domain-separates the version token from the CSRF token. Both are minted by
 * the same signer, so without this a CSRF token could be presented as a
 * version token (or vice versa) for the same principal.
 */
const VERSION_SCOPE = "setup-version";

export interface SetupRouteDeps {
	secrets: SecretStoreBackend;
	/**
	 * The required-key set for one user: their runner's credentials ∪
	 * `containers.requiredSecretKeys`. A function rather than an array because
	 * a Codex user needs no Anthropic credential — see `requiredSecretKeysFor`.
	 */
	requiredKeys: (email?: string) => readonly string[];
	auth: SetupAuthConfig;
	bootstrap: SetupBootstrap;
	csrf: CsrfTokens;
	/** Reads and writes the per-user runner default on the `users` row. */
	store: Pick<
		RouterStore,
		"getUserByEmail" | "getUserDefaultRunner" | "setUserDefaultRunner"
	>;
	/**
	 * Per-user Codex credentials. Absent when this router has no Codex support
	 * configured, in which case the "Codex account" section is not rendered and
	 * its routes refuse.
	 */
	codexTokens?: CodexTokenStore;
	/** Required when `auth.auth.mode === "entra-token"`; ignored otherwise. */
	verifyIdToken?: SetupIdTokenVerifier;
	logger: ILogger;
	/** Test seam. Default 64 KiB, matching {@link parseFormBody}. */
	maxFormBodyBytes?: number;
	/** Test seam for the Codex status row's expiry arithmetic. */
	now?: () => number;
}

/* -------------------------------------------------------------- backends -- */

/** Backends that expose the whole-record surface (today: TableSecretStore). */
interface RecordCapableStore extends SecretStoreBackend {
	supportsRecords(): boolean;
	getRecord(
		email: string,
	): Promise<{ bundle: UserSecretBundle; etag: string } | undefined>;
	putRecord(
		email: string,
		bundle: UserSecretBundle,
		ifMatch?: string,
	): Promise<{ etag: string }>;
}

/**
 * The record API must be **declared**, not merely present — `supportsRecords()`
 * is the seam `TableSecretStore` exposes for exactly this, so a backend that
 * grows an incompatible `getRecord` later cannot be silently routed onto the
 * conditional-write path by a bare `typeof … === "function"` check.
 */
function asRecordStore(
	store: SecretStoreBackend,
): RecordCapableStore | undefined {
	const candidate = store as Partial<RecordCapableStore>;
	if (typeof candidate.supportsRecords !== "function") return undefined;
	if (candidate.supportsRecords() !== true) return undefined;
	if (typeof candidate.getRecord !== "function") return undefined;
	if (typeof candidate.putRecord !== "function") return undefined;
	return store as RecordCapableStore;
}

/**
 * What a render saw: the stored bundle and, where the backend has one, the
 * version it was read at.
 *
 * Deliberately NOT a source of "is this teammate provisioned?" (R2-02). An
 * earlier version reported `exists: Object.keys(bundle).length > 0`, which made
 * registration inferable from a record — and a record was something any
 * authenticated principal could cause to be created. Provisioning is a
 * RouterStore fact; ask {@link SetupBootstrap.isRegistered} for it.
 */
interface RecordState {
	bundle: UserSecretBundle;
	/** Absent on a backend with no record API, or when no record exists. */
	etag?: string;
}

async function readState(
	deps: SetupRouteDeps,
	email: string,
): Promise<RecordState> {
	const record = asRecordStore(deps.secrets);
	if (record) {
		const found = await record.getRecord(email);
		if (!found) return { bundle: {} };
		return { bundle: found.bundle, etag: found.etag };
	}
	// File / Key Vault backends are per-key stores with no version at all.
	return { bundle: await deps.secrets.get(email) };
}

/* --------------------------------------------------------- version token -- */

/**
 * Mints the opaque render-time version token (F8).
 *
 * Shape: `<hex(etag)>.<signed principal-bound token>`. Hex rather than base64
 * because {@link CsrfTokens} lowercases the principal key it signs over, and
 * hex survives that losslessly — a mixed-case payload could otherwise let two
 * ETags differing only in case share a signature.
 */
function issueVersionToken(
	deps: SetupRouteDeps,
	email: string,
	etag: string | undefined,
): string {
	const payload = Buffer.from(etag ?? "", "utf-8").toString("hex");
	return `${payload}.${deps.csrf.issue(`${VERSION_SCOPE}|${email}|${payload}`)}`;
}

/**
 * Recovers the ETag a render captured, or reports the token unusable.
 *
 * `etag: undefined` with `ok: true` is a real state — the record did not exist
 * when the page was rendered — and maps to an unconditional-create (`POST`
 * Insert Entity), never to an unconditional overwrite.
 */
function readVersionToken(
	deps: SetupRouteDeps,
	email: string,
	token: string | undefined,
): { ok: true; etag: string | undefined } | { ok: false } {
	if (!token) return { ok: false };
	const separator = token.indexOf(".");
	if (separator < 0) return { ok: false };
	const payload = token.slice(0, separator);
	if (!/^(?:[0-9a-f]{2})*$/.test(payload)) return { ok: false };
	const signed = token.slice(separator + 1);
	if (!deps.csrf.verify(`${VERSION_SCOPE}|${email}|${payload}`, signed)) {
		return { ok: false };
	}
	const etag = Buffer.from(payload, "hex").toString("utf-8");
	return { ok: true, etag: etag === "" ? undefined : etag };
}

/* ---------------------------------------------------------------- fields -- */

/** A parsed form field: always an array from `parseFormBody`, but be lenient. */
function lastValue(raw: unknown): string | undefined {
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw)) {
		const last = raw.at(-1);
		return typeof last === "string" ? last : undefined;
	}
	return undefined;
}

function fieldsOf(request: FastifyRequest): Record<string, unknown> {
	const body = request.body;
	if (typeof body !== "object" || body === null) return {};
	return body as Record<string, unknown>;
}

/* ------------------------------------------------------------ page model -- */

/** Extra, section-scoped messages a mutation can attach to a re-render. */
interface ModelExtras {
	message?: SetupMessage;
	defaultsMessage?: SetupMessage;
	codexMessage?: SetupMessage;
}

async function buildModel(
	deps: SetupRouteDeps,
	principal: SetupPrincipal,
	state: RecordState,
	extras: ModelExtras = {},
): Promise<SetupPageModel> {
	const requiredKeys = deps.requiredKeys(principal.email);
	const required = new Set(requiredKeys);
	// Required first in configured order, then the rest alphabetically. Without
	// this the table order follows `Object.keys` on a decrypted JSON object and
	// reshuffles whenever a key is added or removed.
	//
	// Stored keys that have SINCE become reserved are filtered out. This change
	// reserves `CYRUS_DEFAULT_RUNNER` and the per-runner model vars, so a user
	// who hand-set one before the picker existed still has it in their bundle —
	// rendering it would offer an edit that `buildEnv` now ignores, which is
	// worse than not showing it. `buildEnv` skips it with a warning either way.
	const names = [
		...requiredKeys,
		...Object.keys(state.bundle)
			.filter((name) => !required.has(name) && !isReservedEnvKey(name))
			.sort(),
	];
	const variables: VariableView[] = names.map((name) => ({
		name,
		required: required.has(name),
		isSet: Boolean(state.bundle[name]),
	}));

	const user = deps.store.getUserByEmail(principal.email);
	const defaultRunner = user
		? resolveDefaultRunner(
				deps.store.getUserDefaultRunner(user.userId),
				deps.logger,
			)
		: undefined;
	const codex =
		deps.codexTokens && user
			? await deps.codexTokens.view(user.userId)
			: undefined;

	return {
		email: principal.email,
		variables,
		missingRequired: requiredKeys.filter((key) => !state.bundle[key]),
		csrfToken: deps.csrf.issue(principal.email),
		versionToken: issueVersionToken(deps, principal.email, state.etag),
		...(defaultRunner ? { defaultRunner } : {}),
		...(codex ? { codex } : {}),
		...(extras.message ? { message: extras.message } : {}),
		...(extras.defaultsMessage
			? { defaultsMessage: extras.defaultsMessage }
			: {}),
		...(extras.codexMessage ? { codexMessage: extras.codexMessage } : {}),
	};
}

/* ---------------------------------------------------------------- render -- */

function secureHtml(reply: FastifyReply): FastifyReply {
	return reply
		.header("content-type", "text/html; charset=utf-8")
		.header("cache-control", "no-store")
		.header("content-security-policy", CSP)
		.header("x-content-type-options", "nosniff")
		.header("referrer-policy", "no-referrer")
		.header("x-frame-options", "DENY");
}

function shell(title: string, body: string, head = ""): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="${STRICT_CSP}">
	<title>${escapeHtml(title)}</title>
	<link rel="stylesheet" href="/setup/assets/pico.css">${head}
</head>
<body><main>${body}</main></body>
</html>`;
}

function renderError(error: SetupAuthError): string {
	const body =
		error.status === 401
			? `<p>You are not signed in. <a href="/.auth/login/aad?post_login_redirect_uri=%2Fsetup">Sign in</a>.</p>`
			: `<p>${escapeHtml(error.message)}</p>`;
	return shell("Cyrus setup", `<h1>Cyrus setup</h1>${body}`);
}

/**
 * The first-visit state (F18). Its only control is a CSRF-protected POST, and
 * it must not be reachable by cross-site navigation.
 *
 * **The submit is an htmx XHR, and that is load-bearing in front of Azure's
 * EasyAuth sidecar — not a styling choice.** EasyAuth rejects a request with a
 * bodyless 403 (substatus 60) before it reaches the router when ALL of:
 *
 *   1. it is a POST authenticated by the session cookie,
 *   2. the User-Agent says a real browser sent it,
 *   3. `Origin` *and* `Referer` are absent or not in `allowedExternalRedirectUrls`,
 *   4. `Origin` is absent or not in the ingress CORS origin list.
 *
 * This form is 1 and 2 by construction. A plain same-origin `<form method=
 * "post">` navigation sends NO `Origin` header in Chromium and WebKit, and
 * `secureHtml` serves every /setup page with `Referrer-Policy: no-referrer`,
 * so it sends no `Referer` either — making 3 and 4 unconditionally true. No
 * value in either allowlist can fix that, because both conditions are
 * satisfied by the headers being *absent*. Every plain-form provision attempt
 * against the deployed router 403'd for exactly this reason.
 *
 * An XHR always carries `Origin`, which is why every other write on this UI
 * (all htmx) works. Keeping `method`/`action` alongside `hx-post` leaves the
 * native submit as a fallback if htmx fails to load — no worse than the
 * current behaviour, and correct the moment scripts run.
 * https://learn.microsoft.com/azure/app-service/overview-authentication-authorization
 */
function renderProvisionPage(email: string, csrfToken: string): string {
	return shell(
		"Cyrus setup",
		`<h1>Cyrus setup</h1>
		<p>Signed in as <strong>${escapeHtml(email)}</strong> &middot; <a href="/.auth/logout">Sign out</a></p>
		<article>
			<h2>Set up your account</h2>
			<p>Your Cyrus account has not been created yet. Setting it up creates your
			session environment so you can add the credentials your sessions need.</p>
			<form method="post" action="/setup/provision" hx-post="/setup/provision">
				<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
				<button type="submit">Set up your account</button>
			</form>
		</article>`,
		'\n\t<script src="/setup/assets/htmx.js" defer></script>',
	);
}

/** Re-renders the fragment with a fresh CSRF/version token and a message. */
async function respond(
	reply: FastifyReply,
	deps: SetupRouteDeps,
	principal: SetupPrincipal,
	status: number,
	message: SetupMessage,
): Promise<FastifyReply> {
	// Re-read rather than reusing the pre-write state: after a conflict the
	// user must see what is ACTUALLY stored, and after a successful write the
	// fragment must carry the NEW version token or the next save 409s.
	const state = await readState(deps, principal.email);
	const model = await buildModel(deps, principal, state, { message });
	return secureHtml(reply)
		.status(status)
		.send(`${renderMessage(model.message)}${renderVariablesTable(model)}`);
}

/**
 * The Session defaults fragment, for `POST /setup/defaults`.
 *
 * A separate swap target from the variables table on purpose: the two forms are
 * independent, and swapping the whole table after a picker change would discard
 * any value the user had typed into it but not yet saved.
 */
async function respondDefaults(
	reply: FastifyReply,
	deps: SetupRouteDeps,
	principal: SetupPrincipal,
	status: number,
	message: SetupMessage,
): Promise<FastifyReply> {
	const state = await readState(deps, principal.email);
	const model = await buildModel(deps, principal, state, {
		defaultsMessage: message,
	});
	return secureHtml(reply).status(status).send(renderDefaultsSection(model));
}

/** The Codex account fragment, for the paste and disconnect routes. */
async function respondCodex(
	reply: FastifyReply,
	deps: SetupRouteDeps,
	principal: SetupPrincipal,
	status: number,
	message: SetupMessage,
): Promise<FastifyReply> {
	const state = await readState(deps, principal.email);
	const model = await buildModel(deps, principal, state, {
		codexMessage: message,
	});
	// `renderCodexSection` renders nothing when this router has no Codex
	// support, which is right for the page but would make a refusal a
	// zero-length body — a status code and no explanation. Fall back to the
	// message alone so the reason always reaches the caller.
	const fragment = renderCodexSection(model);
	return secureHtml(reply)
		.status(status)
		.send(fragment || renderMessage(message));
}

/**
 * The single funnel for every rejected /setup* request, and therefore the only
 * place that can record WHY one was rejected.
 *
 * This used to return the fragment silently. A 401/403 then left no trace at
 * all: the browser showed a bare status code, the fragment explaining the cause
 * was discarded client-side (see the `htmx:beforeSwap` note in views.ts), and
 * the logs said nothing — so an operator debugging a refused save had no signal
 * on either side of the wire. The message is server-authored and carries no
 * credential; the email is already logged on the provisioning path.
 */
function sendError(
	deps: SetupRouteDeps,
	reply: FastifyReply,
	error: SetupAuthError,
): FastifyReply {
	deps.logger.warn(
		`Setup request refused with ${error.status}: ${error.message}`,
	);
	// Logged first, always: the redirect must not cost an operator the diagnostic
	// line that says which principal was refused and why.
	if (shouldRedirectToSetup(error, reply.request.url)) {
		return redirectToSetup(reply);
	}
	return secureHtml(reply).status(error.status).send(renderError(error));
}

/**
 * Sends the caller to `/setup`, which renders whichever of sign-in or
 * first-run provisioning they actually need.
 *
 * htmx follows a 3xx transparently and would swap a whole HTML document into
 * whatever fragment slot issued the request, so an htmx caller gets
 * `HX-Redirect` instead — which makes the browser navigate for real. 303 is
 * used rather than 302 so a refused POST is re-issued as a GET.
 */
function redirectToSetup(reply: FastifyReply): FastifyReply {
	if (reply.request.headers["hx-request"]) {
		return reply.header("hx-redirect", "/setup").status(204).send();
	}
	return reply.redirect("/setup", 303);
}

/* ----------------------------------------------------------------- guard -- */

async function authenticate(
	deps: SetupRouteDeps,
	request: FastifyRequest,
): Promise<{ principal: SetupPrincipal } | { error: SetupAuthError }> {
	try {
		const principal = await requireSetupPrincipal(request.headers, deps.auth, {
			...(deps.verifyIdToken ? { verifyIdToken: deps.verifyIdToken } : {}),
		});
		return { principal };
	} catch (error) {
		if (error instanceof SetupAuthError) return { error };
		throw error;
	}
}

/**
 * The shared mutation guard: **principal → CSRF → registration → fields**, in
 * that order and factored exactly once so no mutating route can drift out of it.
 *
 * Order matters. Checking CSRF first would let an unauthenticated caller probe
 * token validity, and a 403 where a 401 belongs also breaks the sign-in
 * redirect.
 *
 * The registration check (R2-02) is the answer to "authentication is not
 * authorization": getting past the auth sidecar proves only that the caller is
 * *some* principal in the tenant. Without this step, any such principal could
 * load `/setup`, take the CSRF token it was handed, and drive a route into
 * creating an encrypted secret record for an unregistered address — values that
 * would then attach to the real account the moment an administrator registered
 * that email. It runs **before any secret read or write**, and it asks
 * {@link SetupBootstrap.authorize}, which resolves an existing user and never
 * creates one, rather than duplicating the rule here.
 *
 * `allowUnregistered` exists for exactly one route: `POST /setup/provision`,
 * whose whole purpose is to create the user, and which therefore calls
 * `bootstrap.ensure` (the auto-provisioning path) instead. Defaulting it to
 * false is what makes a future mutating route fail closed if its author forgets
 * this paragraph exists.
 *
 * The CSRF token is read from the parsed body or the `X-CSRF-Token` header, and
 * **never** from `request.query` (F18).
 */
async function requireMutation(
	deps: SetupRouteDeps,
	request: FastifyRequest,
	options: { allowUnregistered?: boolean } = {},
): Promise<
	| { principal: SetupPrincipal; fields: Record<string, unknown> }
	| {
			error: SetupAuthError;
	  }
> {
	const auth = await authenticate(deps, request);
	if ("error" in auth) return auth;

	const fields = fieldsOf(request);
	const header = request.headers["x-csrf-token"];
	const token =
		lastValue(fields.csrf) ?? (typeof header === "string" ? header : undefined);
	if (!token || !deps.csrf.verify(auth.principal.email, token)) {
		return {
			error: new SetupAuthError(
				403,
				"This page expired, or the request did not come from it. Reload the page and try again.",
			),
		};
	}

	if (!options.allowUnregistered) {
		try {
			deps.bootstrap.authorize(auth.principal);
		} catch (error) {
			if (error instanceof SetupAuthError) return { error };
			throw error;
		}
	}
	return { principal: auth.principal, fields };
}

/* ------------------------------------------------------------ applyEdits -- */

export interface AppliedEdits {
	next: UserSecretBundle;
	changed: boolean;
	/** Submitted for variables the record no longer has — a stale form. */
	ignored: string[];
}

/**
 * Folds a submitted form over the stored bundle.
 *
 * An empty `value:` field means **unchanged**, not "clear". The page renders
 * every input blank because stored values never reach the browser, so blank is
 * the resting state of an untouched field — treating it as a clear would make
 * every save a silent credential wipe. Clearing is therefore an explicit
 * `clear:` checkbox (required variables) or the delete button (optional ones).
 *
 * `clear` beats `value` when both arrive: the user most likely changed their
 * mind about what they typed, and clearing is the safe direction — a missing
 * required value blocks a container boot loudly, while a wrong one fails
 * opaquely inside a session.
 *
 * Throws on a reserved or malformed name rather than skipping it: such a name
 * cannot have come from a rendered row, so the form was tampered with, and
 * dropping it silently would make an attack look like a successful save.
 */
export function applyEdits(
	current: UserSecretBundle,
	fields: Record<string, unknown>,
	requiredKeys: readonly string[],
): AppliedEdits {
	const next = { ...current };
	const ignored: string[] = [];
	let changed = false;

	const edits = new Map<string, { value?: string; clear: boolean }>();
	for (const [field, raw] of Object.entries(fields)) {
		const isValue = field.startsWith(VALUE_PREFIX);
		const isClear = field.startsWith(CLEAR_PREFIX);
		if (!isValue && !isClear) continue;

		const submittedName = field.slice(
			isValue ? VALUE_PREFIX.length : CLEAR_PREFIX.length,
		);
		// A name that BECAME reserved after it was stored is a real,
		// non-adversarial case — this change reserves `CYRUS_DEFAULT_RUNNER` and
		// the per-runner model vars, which users could set by hand before the
		// picker existed. `normalizeSecretKey` throws on a reserved name, and
		// letting that throw here would fail the ENTIRE save, leaving such a user
		// unable to change anything at all until an operator edited their record.
		// Treat it as stale instead: same handling as any other field that no
		// longer corresponds to a rendered row, and `buildModel` has already
		// stopped rendering it.
		//
		// Scoped to `isLateReservedEnvKey`, NOT to every reserved name: a form
		// submitting `PATH` or `CYRUS_DEVICE_TOKEN` cannot have come from a
		// rendered row at any point in this UI's history, so that stays a hard
		// failure rather than a silently-ignored field.
		if (isLateReservedEnvKey(submittedName)) {
			ignored.push(submittedName);
			continue;
		}
		// The single source of truth for reserved names, the env-name regex, and
		// legacy-name mapping. Never write a second validator here.
		const name = normalizeSecretKey(submittedName);
		const entry = edits.get(name) ?? { clear: false };
		if (isClear) entry.clear = true;
		else entry.value = lastValue(raw);
		edits.set(name, entry);
	}

	// The set of names the user could legitimately have edited, which must mirror
	// what `buildModel` puts on the page: `requiredKeys` ∪ the stored keys.
	// Checking `Object.hasOwn(next, name)` alone was narrower than the rendered
	// form, so a required key absent from the bundle rendered an editable row
	// whose contents were then silently discarded — the save answered "No
	// changes to save" and wrote nothing. That happens whenever a name is added
	// to `containers.requiredSecretKeys` after a teammate was provisioned, and
	// to any record deleted or restored without its full key set.
	const editable = new Set([
		...requiredKeys.map((key) => normalizeSecretKey(key)),
		...Object.keys(next),
	]);

	for (const [name, edit] of edits) {
		if (!editable.has(name)) {
			ignored.push(name);
			continue;
		}
		if (edit.clear) {
			// Empty, not deleted: a required row must keep rendering, and
			// `isFullyAuthenticated` already treats "" as missing.
			if (next[name] !== "") changed = true;
			next[name] = "";
			continue;
		}
		if (edit.value === undefined || edit.value === "") continue;
		if (next[name] !== edit.value) changed = true;
		next[name] = edit.value;
	}

	// `requiredKeys` is consulted above, to build the editable-name set. It is
	// deliberately NOT consulted in the loop: a clear is a set-to-empty whether
	// or not the key is required.
	return { next, changed, ignored };
}

/**
 * Pre-write size gate (D3′).
 *
 * The Table backend enforces this inside `sealBundle`, but by then the write
 * is already in flight and the file backend enforces nothing at all. Checking
 * here means every backend refuses the same bundle, with a message that names
 * the offending variable and contains no value.
 */
function bundleTooLarge(
	bundle: UserSecretBundle,
): BundleTooLargeError | undefined {
	const bytes = Buffer.byteLength(JSON.stringify(bundle), "utf-8");
	if (bytes <= MAX_BUNDLE_BYTES) return undefined;
	let worstName = "(none)";
	let worstBytes = -1;
	for (const [key, value] of Object.entries(bundle)) {
		const size = Buffer.byteLength(value, "utf-8");
		if (size > worstBytes) {
			worstBytes = size;
			worstName = key;
		}
	}
	return new BundleTooLargeError(
		`Your saved variables total ${bytes} bytes, which is over the ${MAX_BUNDLE_BYTES} byte limit. The largest is "${worstName}" at ${worstBytes} bytes — shorten or remove it and try again.`,
		worstName,
	);
}

/* ---------------------------------------------------------------- routes -- */

export function registerSetupRoutes(
	fastify: FastifyInstance,
	deps: SetupRouteDeps,
): void {
	const maxBytes = deps.maxFormBodyBytes ?? DEFAULT_MAX_FORM_BODY_BYTES;

	// Fastify v5 parses JSON out of the box but not urlencoded, which is what
	// htmx submits. `parseFormBody` returns `string[]` per field so a repeated
	// `value:NAME` is never silently collapsed.
	fastify.addContentTypeParser(
		"application/x-www-form-urlencoded",
		{ parseAs: "string", bodyLimit: maxBytes },
		(_request, body, done) => {
			try {
				done(null, parseFormBody(body as string, { maxBytes }));
			} catch (error) {
				if (error instanceof FormBodyTooLargeError) {
					(error as Error & { statusCode?: number }).statusCode = 413;
				}
				done(error as Error, undefined);
			}
		},
	);

	// Assets carry no user data and are deliberately unauthenticated: gating
	// them would race the sign-in redirect against the first paint.
	fastify.get("/setup/assets/pico.css", async (_request, reply) =>
		reply
			.header("content-type", "text/css; charset=utf-8")
			.header("cache-control", "public, max-age=31536000, immutable")
			.header("x-content-type-options", "nosniff")
			.send(PICO_CSS),
	);
	fastify.get("/setup/assets/htmx.js", async (_request, reply) =>
		reply
			.header("content-type", "text/javascript; charset=utf-8")
			.header("cache-control", "public, max-age=31536000, immutable")
			.header("x-content-type-options", "nosniff")
			.send(HTMX_JS),
	);

	/**
	 * Read-only (F18). Never calls `bootstrap.ensure()`: a state-changing GET
	 * let a cross-site navigation provision an account for any signed-in
	 * tenant user, on a route that carries no CSRF token.
	 */
	fastify.get("/setup", async (request, reply) => {
		const auth = await authenticate(deps, request);
		if ("error" in auth) return sendError(deps, reply, auth.error);

		// "Provisioned" is a RouterStore fact, not a shape the secret bundle
		// happens to have (R2-02). Reading it from the bundle let a principal who
		// had caused a record to exist be treated as registered — and the record
		// is the thing an unregistered principal could create. Asking the store
		// first also means an unregistered principal's GET reads no secret at all.
		if (!deps.bootstrap.isRegistered(auth.principal)) {
			return secureHtml(reply).send(
				renderProvisionPage(
					auth.principal.email,
					deps.csrf.issue(auth.principal.email),
				),
			);
		}
		const state = await readState(deps, auth.principal.email);
		return secureHtml(reply).send(
			renderPage(await buildModel(deps, auth.principal, state)),
		);
	});

	/** The table fragment on its own, for an explicit refresh. Read-only. */
	fastify.get("/setup/variables", async (request, reply) => {
		const auth = await authenticate(deps, request);
		if ("error" in auth) return sendError(deps, reply, auth.error);
		// The only /setup* route that read the secret store without first
		// confirming the principal has a `users` row. Being read-only did not
		// excuse it: `readState` still touches the backend on behalf of an
		// unregistered address, and the caller has no page to be refreshing.
		try {
			deps.bootstrap.authorize(auth.principal);
		} catch (error) {
			if (error instanceof SetupAuthError) return sendError(deps, reply, error);
			throw error;
		}
		const state = await readState(deps, auth.principal.email);
		return secureHtml(reply).send(
			renderVariablesTable(await buildModel(deps, auth.principal, state)),
		);
	});

	/**
	 * Where provisioning lives now (F18): CSRF-protected, so it cannot be
	 * triggered by a cross-site navigation or an image tag.
	 */
	fastify.post("/setup/provision", async (request, reply) => {
		// The one route that may be reached by a principal with no user row: it
		// is the route that creates it. Authorization is `bootstrap.ensure`'s
		// `autoProvisionUsers` decision instead.
		const guard = await requireMutation(deps, request, {
			allowUnregistered: true,
		});
		if ("error" in guard) return sendError(deps, reply, guard.error);

		try {
			await deps.bootstrap.ensure(guard.principal);
		} catch (error) {
			// An unregistered user with auto-provisioning off lands here with the
			// 403 and the exact command an administrator has to run.
			if (error instanceof SetupAuthError) return sendError(deps, reply, error);
			throw error;
		}
		// The htmx submit (see `renderProvisionPage`) expects a fragment, and the
		// success body here is a whole document — swapping that into the page
		// would nest a second <html>. Reload /setup instead: the account now
		// exists, so it renders the real page. The non-htmx fallback keeps the
		// inline render below, which is also what the tests drive.
		if (request.headers["hx-request"]) {
			return redirectToSetup(reply);
		}
		const state = await readState(deps, guard.principal.email);
		return secureHtml(reply).send(
			renderPage(
				await buildModel(deps, guard.principal, state, {
					message: {
						kind: "ok",
						text: "Your account is ready. Enter your credentials below and save.",
					},
				}),
			),
		);
	});

	fastify.post("/setup/variables", async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) return sendError(deps, reply, guard.error);

		const raw = lastValue(guard.fields.name)?.trim() ?? "";
		let name: string;
		try {
			if (!raw) throw new Error("Enter a variable name.");
			name = normalizeSecretKey(raw);
		} catch (error) {
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: (error as Error).message,
			});
		}

		const state = await readState(deps, guard.principal.email);
		if (Object.hasOwn(state.bundle, name)) {
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: `${name} already exists. Set its value below and save.`,
			});
		}

		// Empty on creation: the value is typed into the table and committed by
		// the save flow, so adding a variable never posts a secret.
		await deps.secrets.set(guard.principal.email, name, "");
		return respond(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: `Added ${name}. Enter its value and save.`,
		});
	});

	fastify.delete<{ Params: { name: string } }>(
		"/setup/variables/:name",
		async (request, reply) => {
			const guard = await requireMutation(deps, request);
			if ("error" in guard) return sendError(deps, reply, guard.error);

			let name: string;
			try {
				// Fastify's router already percent-decodes path params; decoding
				// again would corrupt a literal '%' and can throw URIError.
				name = normalizeSecretKey(request.params.name);
			} catch (error) {
				return respond(reply, deps, guard.principal, 400, {
					kind: "error",
					text: (error as Error).message,
				});
			}

			// The row renders without a delete button, but the route is reachable
			// by hand. Removing a required key makes `ContainerTargets.buildEnv`
			// throw "not fully authenticated" on the next boot, so refuse it
			// server-side — after normalization, so a legacy alias cannot slip
			// past the check.
			if (deps.requiredKeys(guard.principal.email).includes(name)) {
				return respond(reply, deps, guard.principal, 400, {
					kind: "error",
					text: `${name} is required and cannot be deleted. Clear its value instead.`,
				});
			}

			const state = await readState(deps, guard.principal.email);
			if (Object.hasOwn(state.bundle, name)) {
				// Always keyed by the signed-in principal — never by anything the
				// request supplied beyond the variable name.
				await deps.secrets.set(guard.principal.email, name, undefined);
			}
			return respond(reply, deps, guard.principal, 200, {
				kind: "ok",
				text: `Removed ${name}.`,
			});
		},
	);

	fastify.post("/setup/save", async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) return sendError(deps, reply, guard.error);

		const email = guard.principal.email;
		const recordStore = asRecordStore(deps.secrets);

		// F8: the version the USER'S PAGE saw, not the one this handler could
		// read. Reading it here would make the conditional write conditional on
		// a value observed microseconds earlier, which no concurrent writer can
		// realistically invalidate — the conflict could never fire.
		const version = readVersionToken(
			deps,
			email,
			lastValue(guard.fields.version),
		);
		if (recordStore && !version.ok) {
			// Never fall through to an unconditional write (F7): that is the
			// fail-open upsert the ETag exists to prevent.
			return respond(reply, deps, guard.principal, 409, {
				kind: "conflict",
				text: "This page is out of date. The current values are shown below — re-enter your changes and save again.",
			});
		}

		const state = await readState(deps, email);
		let applied: AppliedEdits;
		try {
			applied = applyEdits(
				state.bundle,
				guard.fields,
				deps.requiredKeys(email),
			);
		} catch (error) {
			// A name that never appeared on a rendered row: fail the whole save
			// rather than partially applying a tampered form.
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: (error as Error).message,
			});
		}

		if (applied.ignored.length > 0) {
			deps.logger.warn(
				`Ignoring stale setup fields for ${email}: ${applied.ignored.join(", ")}`,
			);
		}

		if (!applied.changed) {
			return respond(reply, deps, guard.principal, 200, {
				kind: "ok",
				text: "No changes to save.",
			});
		}

		const tooLarge = bundleTooLarge(applied.next);
		if (tooLarge) {
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: tooLarge.message,
			});
		}

		try {
			if (recordStore && version.ok) {
				// One conditional write for the whole form: atomic, and the
				// render-time ETag is what turns a concurrent edit into a visible
				// conflict instead of a silent overwrite. `undefined` here means
				// "no record existed at render time" and maps to an insert, not to
				// an unconditional overwrite.
				await recordStore.putRecord(email, applied.next, version.etag);
			} else {
				// File / Key Vault backends have no record surface: sequential
				// writes, last-write-wins — the semantics `cyrus router secrets
				// set` has always had on these backends.
				for (const [name, value] of Object.entries(applied.next)) {
					if (state.bundle[name] === value) continue;
					await deps.secrets.set(email, name, value);
				}
			}
		} catch (error) {
			if (error instanceof SetupConflictError) {
				// Deliberately no retry and no merge: a retry would reinstate
				// exactly the overwrite the ETag exists to prevent, and a merge
				// would silently combine two people's intentions.
				return respond(reply, deps, guard.principal, 409, {
					kind: "conflict",
					text: "Your settings were changed somewhere else while you were editing. The current values are shown below — re-enter your changes and save again.",
				});
			}
			if (error instanceof BundleTooLargeError) {
				return respond(reply, deps, guard.principal, 400, {
					kind: "error",
					text: error.message,
				});
			}
			throw error;
		}

		// The old wording — "applies to the next session that starts" — was wrong
		// for an issue that already has a container. `resolveTarget`'s fast path
		// returns the affinity-pinned device before `executorFor` is consulted, so
		// there may be no next `ensureDevice` for that issue at all: the old
		// values survive for the life of the CONTAINER, not of one session. The
		// remedy `docs/ROUTER.md` prescribes has never been mentioned here.
		return respond(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: "Saved. New values apply to issues that start a container after now. An issue that already has one keeps the values it booted with — to apply these to it now, run `cyrus router containers destroy <issueKey>` and re-prompt the issue.",
		});
	});

	/**
	 * The runner/model picker (NOR-364).
	 *
	 * Separate from `/setup/save` because it writes a different store — the
	 * `users` row, not the secret bundle — and so has no ETag to carry. The
	 * router is single-replica SQLite, so there is no contention to guard
	 * against here the way there is on the Table-backed bundle.
	 */
	fastify.post("/setup/defaults", async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) return sendError(deps, reply, guard.error);

		const user = deps.store.getUserByEmail(guard.principal.email);
		if (!user) {
			// `requireMutation` already proved the user exists; this can only be a
			// row deleted between the two reads.
			return respondDefaults(reply, deps, guard.principal, 409, {
				kind: "conflict",
				text: "Your account is no longer registered. Reload the page.",
			});
		}

		const raw = lastValue(guard.fields.default_runner)?.trim() ?? "";
		if (raw === "") {
			deps.store.setUserDefaultRunner(user.userId, null);
			return respondDefaults(reply, deps, guard.principal, 200, {
				kind: "ok",
				text: "Cleared. Your sessions will use the router's own default agent and model.",
			});
		}

		const selection = parseSelection(raw);
		if (!selection) {
			// Only values from a rendered `<option>` are accepted. Passing an
			// unknown one through is exactly the failure this typed control
			// exists to remove: `WorkerService` casts the env var without parsing
			// it, so a bad value throws inside the sandbox at session start and
			// the user sees a dead session rather than a setup error.
			return respondDefaults(reply, deps, guard.principal, 400, {
				kind: "error",
				text: "That is not an agent and model Cyrus can run in a container. Pick one from the list and save again.",
			});
		}

		deps.store.setUserDefaultRunner(
			user.userId,
			encodeDefaultRunnerJson(selection),
		);
		return respondDefaults(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: `Saved. New issues will run ${selection.runner} on ${selection.model}. An issue that already has a container keeps its current agent until the container is replaced.`,
		});
	});

	/**
	 * Bootstraps a Codex subscription credential from a pasted `auth.json`
	 * (ADR 0005).
	 *
	 * Validated on submit, and every rejection names what is wrong. That is the
	 * whole point: a malformed paste accepted silently surfaces as a dead Codex
	 * session hours later — the failure mode the typed picker exists to
	 * eliminate — and by then nothing connects the two events.
	 */
	fastify.post("/setup/codex", async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) return sendError(deps, reply, guard.error);

		const codexTokens = deps.codexTokens;
		if (!codexTokens) {
			return respondCodex(reply, deps, guard.principal, 400, {
				kind: "error",
				text: "This router has no Codex support configured. Ask an administrator to set `containers.codex` in router-config.json.",
			});
		}
		const user = deps.store.getUserByEmail(guard.principal.email);
		if (!user) {
			return respondCodex(reply, deps, guard.principal, 409, {
				kind: "conflict",
				text: "Your account is no longer registered. Reload the page.",
			});
		}

		let credential: ReturnType<typeof parseCodexAuthPaste>;
		try {
			credential = parseCodexAuthPaste(
				lastValue(guard.fields.codex_auth_json) ?? "",
				(deps.now ?? Date.now)(),
			);
		} catch (error) {
			if (error instanceof CodexAuthValidationError) {
				return respondCodex(reply, deps, guard.principal, 400, {
					kind: "error",
					text: error.message,
				});
			}
			throw error;
		}

		await codexTokens.put(user.userId, credential);
		deps.logger.info(
			`Connected a Codex subscription credential for ${guard.principal.email}`,
		);
		return respondCodex(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: "Connected. Cyrus will refresh this for you and hand each container a fresh copy at boot.",
		});
	});

	/**
	 * Forgets the stored credential. A POST rather than a DELETE so htmx sends
	 * it as a body-carrying request — see the note on `renderDeleteButton` for
	 * why htmx puts DELETE parameters in the query string, which this UI refuses.
	 */
	fastify.post("/setup/codex/disconnect", async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) return sendError(deps, reply, guard.error);

		const codexTokens = deps.codexTokens;
		const user = deps.store.getUserByEmail(guard.principal.email);
		if (!codexTokens || !user) {
			return respondCodex(reply, deps, guard.principal, 400, {
				kind: "error",
				text: "There is nothing to disconnect.",
			});
		}
		codexTokens.clear(user.userId);
		deps.logger.info(
			`Disconnected the Codex subscription credential for ${guard.principal.email}`,
		);
		return respondCodex(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: "Disconnected. Codex sessions will fail to start until you connect an account again or set OPENAI_API_KEY.",
		});
	});
}
