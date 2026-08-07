import {
	AssociationParseError,
	formatAssociations,
	type ILogger,
	parseAssociations,
} from "cyrus-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
	type RegisteredRepository,
	type RepositoryRegistry,
	validateRegisteredRepository,
} from "../RepositoryRegistry.js";
import { SetupConflictError } from "../TableSecretStore.js";
import type { SetupBootstrap } from "./bootstrap.js";
import type { CsrfTokens } from "./csrf.js";
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
	findAmbiguities,
	type RepositoriesPageModel,
	type RepositoryView,
	renderRepositoriesPage,
	renderRepositoriesTable,
} from "./repositoryViews.js";
import { escapeHtml, renderMessage, type SetupMessage } from "./views.js";

/**
 * HTTP surface for `/setup/repositories*`, the global repository registry.
 *
 * Three properties carry over from `routes.ts` and are each pinned by a test:
 *
 * 1. **`GET` is read-only.** It never provisions and never writes.
 * 2. **The registry version is captured at RENDER time** and the save performs
 *    its conditional write against THAT version, so a concurrent edit is a
 *    visible 409 rather than a silent overwrite.
 * 3. **CSRF is body-or-header only, never a query string** — an 8-hour token in
 *    a URL lands in access logs and browser history.
 *
 * Unlike the variables page, values here ARE rendered back: repository names
 * and slugs are configuration, not credentials, and editing requires seeing
 * them. Nothing on this page ever reads the secret store.
 *
 * Authorization is `bootstrap.authorize` — any registered Cyrus user may edit.
 * The registry is global, so every mutation is logged with the actor's email.
 */

const CSP = [
	"default-src 'none'",
	"style-src 'self' 'unsafe-inline'",
	"script-src 'self' 'unsafe-inline'",
	"img-src 'self' data:",
	"connect-src 'self'",
	"form-action 'self'",
	"frame-ancestors 'none'",
	"base-uri 'none'",
].join("; ");

/** Domain-separates the version token from the CSRF token (same signer). */
const VERSION_SCOPE = "setup-repos-version";

export interface RepositoryRouteDeps {
	registry: RepositoryRegistry;
	/** Workspace ids the router serves; one means the field is auto-filled. */
	workspaceIds: string[];
	auth: SetupAuthConfig;
	bootstrap: SetupBootstrap;
	csrf: CsrfTokens;
	verifyIdToken?: SetupIdTokenVerifier;
	logger: ILogger;
	maxFormBodyBytes?: number;
}

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

/**
 * Recursively sorts object keys (never array element order — associations and
 * routing labels are ordered lists, and reordering them is a real edit) so two
 * structurally identical `RegisteredRepository` values compare equal
 * regardless of construction order.
 */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value !== null && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(
			([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
		);
		return Object.fromEntries(
			entries.map(([key, entryValue]) => [key, canonicalize(entryValue)]),
		);
	}
	return value;
}

/**
 * Structural equality for the `changed` check below. A plain
 * `JSON.stringify(a) !== JSON.stringify(b)` is key-order sensitive, so a
 * registry seeded from `containers.repositories` (whose entries can be built
 * in any key order) could report "Saved" on a save that changed nothing —
 * `applyRepositoryEdits` itself always constructs rows in one fixed order, so
 * this only bites a store whose stored order differs from that.
 */
function stableStringify(value: unknown): string {
	return JSON.stringify(canonicalize(value));
}

function secureHtml(reply: FastifyReply): FastifyReply {
	return reply
		.header("content-type", "text/html; charset=utf-8")
		.header("cache-control", "no-store")
		.header("content-security-policy", CSP)
		.header("x-content-type-options", "nosniff")
		.header("referrer-policy", "no-referrer")
		.header("x-frame-options", "DENY");
}

/**
 * Adapts a stored registry entry onto the render model. `formatAssociations`
 * is the ONLY place that builds `RepositoryView.associations` — Task 14's
 * views layer treats that field as an already-formatted string and never
 * calls it itself, so this is the sole reformation point for `p=`/`t=` syntax.
 */
function toView(repo: RegisteredRepository): RepositoryView {
	return {
		name: repo.name,
		githubSlug: repo.githubSlug,
		baseBranch: repo.baseBranch ?? "main",
		associations: formatAssociations({
			...(repo.projectKeys ? { projectKeys: repo.projectKeys } : {}),
			...(repo.teamKeys ? { teamKeys: repo.teamKeys } : {}),
		}),
		isDefault: repo.isDefault === true,
	};
}

/**
 * Mints the opaque render-time version token (mirrors `routes.ts`'s ETag
 * handling exactly). Shape: `<hex(version)>.<signed principal-bound token>`.
 *
 * This is signed, and deliberately not a raw passthrough of
 * `RegistrySnapshot.version`: without a signature, a registered principal
 * could submit `version=*` directly to `POST /setup/repositories/save`, which
 * `TableRepositoryRegistry.put` would forward unfiltered into `If-Match: *` —
 * the Table service's own escape hatch for "write unconditionally," which is
 * exactly the last-writer-wins upsert the whole render-time-version design
 * exists to prevent. `applyRepositoryEdits` drops every repository whose row
 * was not submitted, so that single forged save can wipe the rest of the
 * registry. Signing closes this off: `readVersionToken` below only accepts a
 * token this same process issued for this exact principal, so a caller can
 * never present a version the render never actually produced.
 *
 * Hex rather than base64 for the same reason `routes.ts` uses it: it survives
 * `CsrfTokens`' principal-key lowercasing losslessly. `version: undefined`
 * (no registry has ever been written — the Table backend returns no ETag on a
 * 404) hex-encodes to `""`, which is what lets `readVersionToken` tell "no
 * registry existed at render time" apart from "the field is missing/tampered"
 * — the former is a legitimate first-write, the latter is refused.
 */
function issueVersionToken(
	deps: RepositoryRouteDeps,
	email: string,
	version: string | undefined,
): string {
	const payload = Buffer.from(version ?? "", "utf-8").toString("hex");
	return `${payload}.${deps.csrf.issue(`${VERSION_SCOPE}|${email}|${payload}`)}`;
}

/**
 * Recovers the version a render captured, or reports the token unusable.
 *
 * `version: undefined` with `ok: true` is a real, legitimate state — no
 * registry existed when the page was rendered — and maps to
 * `RepositoryRegistry.put`'s unconditional-FIRST-write semantics, never to an
 * unconditional overwrite of an existing registry (which requires an actual
 * matching version). Any token that doesn't verify — missing, malformed, or
 * signed for a different principal or payload — reports `ok: false`, and the
 * caller must treat that as a conflict rather than ever falling through to
 * calling `registry.put` with a caller-supplied string.
 */
function readVersionToken(
	deps: RepositoryRouteDeps,
	email: string,
	token: string | undefined,
): { ok: true; version: string | undefined } | { ok: false } {
	if (!token) return { ok: false };
	const separator = token.indexOf(".");
	if (separator < 0) return { ok: false };
	const payload = token.slice(0, separator);
	if (!/^(?:[0-9a-f]{2})*$/.test(payload)) return { ok: false };
	if (
		!deps.csrf.verify(
			`${VERSION_SCOPE}|${email}|${payload}`,
			token.slice(separator + 1),
		)
	) {
		return { ok: false };
	}
	const version = Buffer.from(payload, "hex").toString("utf-8");
	return { ok: true, version: version === "" ? undefined : version };
}

async function buildModel(
	deps: RepositoryRouteDeps,
	principal: SetupPrincipal,
	message?: SetupMessage,
): Promise<RepositoriesPageModel> {
	const { repositories, version } = await deps.registry.list();
	const views = repositories.map(toView);
	return {
		email: principal.email,
		repositories: views,
		workspaceIds: deps.workspaceIds,
		ambiguities: findAmbiguities(views),
		csrfToken: deps.csrf.issue(principal.email),
		versionToken: issueVersionToken(deps, principal.email, version),
		...(message ? { message } : {}),
	};
}

async function respond(
	reply: FastifyReply,
	deps: RepositoryRouteDeps,
	principal: SetupPrincipal,
	status: number,
	message: SetupMessage,
): Promise<FastifyReply> {
	// Re-read: after a conflict the user must see what is ACTUALLY stored, and
	// after a success the fragment must carry the NEW version token or the next
	// save 409s.
	const model = await buildModel(deps, principal, message);
	return secureHtml(reply)
		.status(status)
		.send(`${renderMessage(model.message)}${renderRepositoriesTable(model)}`);
}

async function authenticate(
	deps: RepositoryRouteDeps,
	request: FastifyRequest,
): Promise<{ principal: SetupPrincipal } | { error: SetupAuthError }> {
	try {
		return {
			principal: await requireSetupPrincipal(request.headers, deps.auth, {
				...(deps.verifyIdToken ? { verifyIdToken: deps.verifyIdToken } : {}),
			}),
		};
	} catch (error) {
		if (error instanceof SetupAuthError) return { error };
		throw error;
	}
}

/** principal -> CSRF -> registration -> fields, in that order. See routes.ts. */
async function requireMutation(
	deps: RepositoryRouteDeps,
	request: FastifyRequest,
): Promise<
	| { principal: SetupPrincipal; fields: Record<string, unknown> }
	| { error: SetupAuthError }
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

	try {
		deps.bootstrap.authorize(auth.principal);
	} catch (error) {
		if (error instanceof SetupAuthError) return { error };
		throw error;
	}
	return { principal: auth.principal, fields };
}

function sendError(
	deps: RepositoryRouteDeps,
	reply: FastifyReply,
	error: SetupAuthError,
): FastifyReply {
	deps.logger.warn(
		`Repository setup request refused with ${error.status}: ${error.message}`,
	);
	// Logged first, always: the redirect must not cost an operator the diagnostic
	// line that says which principal was refused and why.
	//
	// Every route in this file lives under /setup/repositories, so this absorbs
	// BOTH "not signed in" and "no user row yet" — the sign-in link this branch
	// used to render is gone because it is now unreachable. That deep-link dead
	// end is the whole point: a teammate who bookmarks the repositories page and
	// has never opened /setup was told to ask an administrator to run a CLI
	// command, on a deployment where clicking one button would have done it.
	if (shouldRedirectToSetup(error, reply.request.url)) {
		if (reply.request.headers["hx-request"]) {
			return reply.header("hx-redirect", "/setup").status(204).send();
		}
		return reply.redirect("/setup", 303);
	}
	return secureHtml(reply)
		.status(error.status)
		.send(
			`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Cyrus repositories</title></head><body><main><h1>Cyrus repositories</h1><p>${escapeHtml(error.message)}</p></main></body></html>`,
		);
}

/**
 * Folds a submitted form over the stored registry.
 *
 * A row is identified by its hidden `repo:<name>` marker, so a repository whose
 * row was not submitted is DROPPED — that is what makes the delete button's
 * effect survive a subsequent save. `isDefault` is one radio for the whole
 * table, so applying it here is what guarantees at most one default per write:
 * the fold only sets `isDefault: true` on the row whose name equals the single
 * submitted `isDefault` value, and every other row gets no `isDefault` key at
 * all (dropping a previous default rather than leaving it stale). Because that
 * decision is made here in code — not merely by the radio-button markup — it
 * holds even against a hand-crafted request with multiple `isDefault` values,
 * since `lastValue` collapses them to one before the fold runs.
 */
export function applyRepositoryEdits(
	current: RegisteredRepository[],
	fields: Record<string, unknown>,
): { next: RegisteredRepository[]; changed: boolean } {
	const submitted = new Set(
		Object.keys(fields)
			.filter((field) => field.startsWith("repo:"))
			.map((field) => field.slice("repo:".length)),
	);
	const defaultName = lastValue(fields.isDefault);

	const next: RegisteredRepository[] = [];
	for (const repo of current) {
		if (!submitted.has(repo.name)) continue;

		const slug = lastValue(fields[`slug:${repo.name}`])?.trim();
		const branch = lastValue(fields[`branch:${repo.name}`])?.trim();
		const associations = lastValue(fields[`assoc:${repo.name}`]) ?? "";
		const parsed = parseAssociations(associations);

		next.push({
			name: repo.name,
			githubSlug: slug && slug !== "" ? slug : repo.githubSlug,
			linearWorkspaceId: repo.linearWorkspaceId,
			baseBranch:
				branch && branch !== "" ? branch : (repo.baseBranch ?? "main"),
			...(parsed.teamKeys.length > 0 ? { teamKeys: parsed.teamKeys } : {}),
			...(parsed.projectKeys.length > 0
				? { projectKeys: parsed.projectKeys }
				: {}),
			...(repo.routingLabels ? { routingLabels: repo.routingLabels } : {}),
			...(defaultName === repo.name ? { isDefault: true } : {}),
		});
	}

	return {
		next,
		changed: stableStringify(next) !== stableStringify(current),
	};
}

export function registerRepositoryRoutes(
	fastify: FastifyInstance,
	deps: RepositoryRouteDeps,
): void {
	const maxBytes = deps.maxFormBodyBytes ?? DEFAULT_MAX_FORM_BODY_BYTES;

	// Registered idempotently: `registerSetupRoutes` may already have added this
	// parser on the same instance, and Fastify throws on a duplicate.
	if (!fastify.hasContentTypeParser("application/x-www-form-urlencoded")) {
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
	}

	fastify.get("/setup/repositories", async (request, reply) => {
		const auth = await authenticate(deps, request);
		if ("error" in auth) return sendError(deps, reply, auth.error);
		try {
			deps.bootstrap.authorize(auth.principal);
		} catch (error) {
			if (error instanceof SetupAuthError) {
				return sendError(deps, reply, error);
			}
			throw error;
		}
		return secureHtml(reply).send(
			renderRepositoriesPage(await buildModel(deps, auth.principal)),
		);
	});

	fastify.get("/setup/repositories/table", async (request, reply) => {
		const auth = await authenticate(deps, request);
		if ("error" in auth) return sendError(deps, reply, auth.error);
		try {
			deps.bootstrap.authorize(auth.principal);
		} catch (error) {
			if (error instanceof SetupAuthError) {
				return sendError(deps, reply, error);
			}
			throw error;
		}
		return secureHtml(reply).send(
			renderRepositoriesTable(await buildModel(deps, auth.principal)),
		);
	});

	fastify.post("/setup/repositories", async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) return sendError(deps, reply, guard.error);

		const name = lastValue(guard.fields.name)?.trim() ?? "";
		const githubSlug = lastValue(guard.fields.githubSlug)?.trim() ?? "";
		const baseBranch = lastValue(guard.fields.baseBranch)?.trim() || "main";
		const associations = lastValue(guard.fields.associations) ?? "";
		const linearWorkspaceId =
			lastValue(guard.fields.linearWorkspaceId)?.trim() ??
			deps.workspaceIds[0] ??
			"";

		// Membership, not just non-empty: a submitted id outside the configured
		// set can never route anything (`matchRepositories` only ever sees issues
		// from a workspace this router serves), so accepting it just leaves dead
		// configuration a direct POST can create with no corresponding UI to fix
		// it. Skipped only if the router is (unusually) configured with no
		// workspace ids at all, so this can never reject every submission on a
		// router that hasn't told us what "valid" means.
		if (
			deps.workspaceIds.length > 0 &&
			!deps.workspaceIds.includes(linearWorkspaceId)
		) {
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: `Linear workspace ${JSON.stringify(linearWorkspaceId)} is not configured for this router.`,
			});
		}

		let repo: RegisteredRepository;
		try {
			const parsed = parseAssociations(associations);
			repo = {
				name,
				githubSlug,
				linearWorkspaceId,
				baseBranch,
				...(parsed.teamKeys.length > 0 ? { teamKeys: parsed.teamKeys } : {}),
				...(parsed.projectKeys.length > 0
					? { projectKeys: parsed.projectKeys }
					: {}),
			};
			validateRegisteredRepository(repo);
		} catch (error) {
			const message =
				error instanceof AssociationParseError
					? error.message
					: (error as Error).message;
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: message,
			});
		}

		const { repositories, version } = await deps.registry.list();
		if (
			repositories.some(
				(existing) => existing.name.toLowerCase() === name.toLowerCase(),
			)
		) {
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: `${name} is already registered. Edit the existing row instead.`,
			});
		}

		try {
			await deps.registry.put([...repositories, repo], version);
		} catch (error) {
			if (error instanceof SetupConflictError) {
				return respond(reply, deps, guard.principal, 409, {
					kind: "conflict",
					text: "The repository list changed while you were editing. The current list is shown below — add your repository again.",
				});
			}
			throw error;
		}

		deps.logger.info(
			`${guard.principal.email} registered repository ${name} (${githubSlug})`,
		);
		return respond(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: `Added ${name}. New sessions will use it; a session already running keeps the repository it started with.`,
		});
	});

	fastify.post("/setup/repositories/save", async (request, reply) => {
		const guard = await requireMutation(deps, request);
		if ("error" in guard) return sendError(deps, reply, guard.error);

		// The version the USER'S PAGE saw, not one read fresh here — reading it
		// here would make the conditional write conditional on a value observed
		// microseconds earlier, which no concurrent writer could realistically
		// invalidate, so the conflict could never fire.
		const token = readVersionToken(
			deps,
			guard.principal.email,
			lastValue(guard.fields.version),
		);
		if (!token.ok) {
			// Never fall through to an unconditional write — that is the fail-open
			// upsert the signed version token exists to prevent. A missing,
			// malformed, or forged token (e.g. a bare `version=*`) lands here, not
			// in `registry.put`.
			return respond(reply, deps, guard.principal, 409, {
				kind: "conflict",
				text: "This page is out of date. The current repositories are shown below — re-enter your changes and save again.",
			});
		}

		const { repositories } = await deps.registry.list();
		let applied: ReturnType<typeof applyRepositoryEdits>;
		try {
			applied = applyRepositoryEdits(repositories, guard.fields);
			for (const repo of applied.next) validateRegisteredRepository(repo);
		} catch (error) {
			return respond(reply, deps, guard.principal, 400, {
				kind: "error",
				text: (error as Error).message,
			});
		}

		if (!applied.changed) {
			return respond(reply, deps, guard.principal, 200, {
				kind: "ok",
				text: "No changes to save.",
			});
		}

		try {
			await deps.registry.put(applied.next, token.version);
		} catch (error) {
			if (error instanceof SetupConflictError) {
				return respond(reply, deps, guard.principal, 409, {
					kind: "conflict",
					text: "The repository list was changed somewhere else while you were editing. The current list is shown below — re-enter your changes and save again.",
				});
			}
			throw error;
		}

		deps.logger.info(
			`${guard.principal.email} saved the repository registry (${applied.next.length} repositories)`,
		);
		return respond(reply, deps, guard.principal, 200, {
			kind: "ok",
			text: "Saved. New sessions use these repositories; a session already running keeps the repository it started with.",
		});
	});

	fastify.delete<{ Params: { name: string } }>(
		"/setup/repositories/:name",
		async (request, reply) => {
			const guard = await requireMutation(deps, request);
			if ("error" in guard) return sendError(deps, reply, guard.error);

			// Fastify already percent-decodes path params.
			const name = request.params.name;
			const { repositories, version } = await deps.registry.list();
			const next = repositories.filter(
				(repo) => repo.name.toLowerCase() !== name.toLowerCase(),
			);
			if (next.length === repositories.length) {
				return respond(reply, deps, guard.principal, 200, {
					kind: "ok",
					text: `${name} was not registered.`,
				});
			}

			try {
				await deps.registry.put(next, version);
			} catch (error) {
				if (error instanceof SetupConflictError) {
					return respond(reply, deps, guard.principal, 409, {
						kind: "conflict",
						text: "The repository list changed while you were editing. The current list is shown below — try again.",
					});
				}
				throw error;
			}

			deps.logger.info(`${guard.principal.email} removed repository ${name}`);
			return respond(reply, deps, guard.principal, 200, {
				kind: "ok",
				text: `Removed ${name}. Issues already routed to it keep their workspace until it is torn down.`,
			});
		},
	);
}
