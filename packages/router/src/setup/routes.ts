import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
	normalizeSecretKey,
	type SecretStoreBackend,
	type UserSecretBundle,
} from "../SecretStore.js";
import { SetupConflictError } from "../TableSecretStore.js";
import type { SetupBootstrap } from "./bootstrap.js";
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
} from "./principal.js";
import { HTMX_JS } from "./vendor/htmx.js";
import { PICO_CSS } from "./vendor/pico.js";
import {
	escapeHtml,
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
	/** `DEFAULT_REQUIRED_SECRET_KEYS` ∪ `containers.requiredSecretKeys`. */
	requiredKeys: readonly string[];
	auth: SetupAuthConfig;
	bootstrap: SetupBootstrap;
	csrf: CsrfTokens;
	/** Required when `auth.auth.mode === "entra-token"`; ignored otherwise. */
	verifyIdToken?: SetupIdTokenVerifier;
	logger: { info(msg: string): void; warn(msg: string): void };
	/** Test seam. Default 64 KiB, matching {@link parseFormBody}. */
	maxFormBodyBytes?: number;
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

function buildModel(
	deps: SetupRouteDeps,
	principal: SetupPrincipal,
	state: RecordState,
	message?: SetupMessage,
): SetupPageModel {
	const required = new Set(deps.requiredKeys);
	// Required first in configured order, then the rest alphabetically. Without
	// this the table order follows `Object.keys` on a decrypted JSON object and
	// reshuffles whenever a key is added or removed.
	const names = [
		...deps.requiredKeys,
		...Object.keys(state.bundle)
			.filter((name) => !required.has(name))
			.sort(),
	];
	const variables: VariableView[] = names.map((name) => ({
		name,
		required: required.has(name),
		isSet: Boolean(state.bundle[name]),
	}));
	return {
		email: principal.email,
		variables,
		missingRequired: deps.requiredKeys.filter((key) => !state.bundle[key]),
		csrfToken: deps.csrf.issue(principal.email),
		versionToken: issueVersionToken(deps, principal.email, state.etag),
		...(message ? { message } : {}),
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

function shell(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="${STRICT_CSP}">
	<title>${escapeHtml(title)}</title>
	<link rel="stylesheet" href="/setup/assets/pico.css">
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
 * The first-visit state (F18). Its only control is a CSRF-protected POST —
 * deliberately a plain `<form method="post">` rather than an htmx attribute,
 * so it works before any script has loaded and cannot be triggered by a
 * cross-site navigation.
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
			<form method="post" action="/setup/provision">
				<input type="hidden" name="csrf" value="${escapeHtml(csrfToken)}">
				<button type="submit">Set up your account</button>
			</form>
		</article>`,
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
	const model = buildModel(deps, principal, state, message);
	return secureHtml(reply)
		.status(status)
		.send(`${renderMessage(model.message)}${renderVariablesTable(model)}`);
}

function sendError(reply: FastifyReply, error: SetupAuthError): FastifyReply {
	return secureHtml(reply).status(error.status).send(renderError(error));
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

		// The single source of truth for reserved names, the env-name regex, and
		// legacy-name mapping. Never write a second validator here.
		const name = normalizeSecretKey(
			field.slice(isValue ? VALUE_PREFIX.length : CLEAR_PREFIX.length),
		);
		const entry = edits.get(name) ?? { clear: false };
		if (isClear) entry.clear = true;
		else entry.value = lastValue(raw);
		edits.set(name, entry);
	}

	for (const [name, edit] of edits) {
		if (!Object.hasOwn(next, name)) {
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

	// Not consulted above — every clear is a set-to-empty regardless of whether
	// the key is required — but kept in the signature so a future divergence in
	// required-key handling has an obvious home.
	void requiredKeys;
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
		if ("error" in auth) return sendError(reply, auth.error);

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
			renderPage(buildModel(deps, auth.principal, state)),
		);
	});

	/** The table fragment on its own, for an explicit refresh. Read-only. */
	fastify.get("/setup/variables", async (request, reply) => {
		const auth = await authenticate(deps, request);
		if ("error" in auth) return sendError(reply, auth.error);
		const state = await readState(deps, auth.principal.email);
		return secureHtml(reply).send(
			renderVariablesTable(buildModel(deps, auth.principal, state)),
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
		if ("error" in guard) return sendError(reply, guard.error);

		try {
			await deps.bootstrap.ensure(guard.principal);
		} catch (error) {
			// An unregistered user with auto-provisioning off lands here with the
			// 403 and the exact command an administrator has to run.
			if (error instanceof SetupAuthError) return sendError(reply, error);
			throw error;
		}
		const state = await readState(deps, guard.principal.email);
		return secureHtml(reply).send(
			renderPage(
				buildModel(deps, guard.principal, state, {
					kind: "ok",
					text: "Your account is ready. Enter your credentials below and save.",
				}),
			),
		);
	});

	fastify.post("/setup/variables", async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) return sendError(reply, guard.error);

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
			if ("error" in guard) return sendError(reply, guard.error);

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
			if (deps.requiredKeys.includes(name)) {
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
		if ("error" in guard) return sendError(reply, guard.error);

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
			applied = applyEdits(state.bundle, guard.fields, deps.requiredKeys);
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

		return respond(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: "Saved. New values apply to the next session that starts; a session already running keeps the values it started with.",
		});
	});
}
