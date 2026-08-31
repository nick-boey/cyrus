import { randomBytes } from "node:crypto";
import type { CodexAccountView } from "../CodexTokenStore.js";
import {
	type DefaultRunnerSelection,
	encodeSelection,
	RUNNER_CATALOG,
} from "./runnerDefaults.js";

/**
 * Pure HTML rendering for the `/setup` management page. No I/O, no Fastify —
 * every function here is a straight string transform so it is unit-testable
 * without a server. The routes layer (a later wave) is responsible for
 * fetching data, minting the CSRF/version tokens, and wiring these into HTTP
 * responses.
 *
 * Security invariants enforced in this file:
 *  - every interpolated value is passed through {@link escapeHtml}.
 *  - no STORED secret value ever reaches the output. A newly typed value
 *    submitted by the user *does* leave the browser in a request body — see
 *    the D5′ note on {@link renderPage} — but nothing that was ever fetched
 *    from a `SecretStoreBackend` is echoed back here.
 */

/** A single row in the variables table. The value itself never appears. */
export interface VariableView {
	name: string;
	required: boolean;
	/** Whether a non-empty value is currently stored. */
	isSet: boolean;
}

export interface SetupMessage {
	kind: "ok" | "error" | "conflict";
	text: string;
}

export interface SetupPageModel {
	email: string;
	variables: VariableView[];
	/** Names of required variables with no stored value, in display order. */
	missingRequired: string[];
	csrfToken: string;
	message?: SetupMessage;
	/**
	 * Opaque render-time version token (F8): a snapshot of the record's
	 * ETag/version captured at render time, so a later save can detect a
	 * concurrent write instead of silently overwriting it. Carried through
	 * as an inert hidden field — the routes layer mints and verifies it.
	 */
	versionToken?: string;
	/**
	 * The user's stored runner/model default, or `undefined` when they have not
	 * chosen one (rendered as "Router default").
	 */
	defaultRunner?: DefaultRunnerSelection;
	/** A message scoped to the Session defaults section. */
	defaultsMessage?: SetupMessage;
	/**
	 * The Codex account status, or `undefined` when this router has no Codex
	 * support configured — in which case the section is not rendered at all,
	 * rather than rendered disabled. Same principle as Gemini and Cursor being
	 * absent from the runner picker: do not show a control that cannot work.
	 */
	codex?: CodexAccountView;
	/** A message scoped to the Codex account section. */
	codexMessage?: SetupMessage;
}

/** `&` first — escaping it later would double-escape the entities we emit. */
export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function renderMessage(message: SetupMessage | undefined): string {
	if (!message) return "";
	const role = message.kind === "ok" ? "status" : "alert";
	return `<article role="${role}" data-kind="${message.kind}">${escapeHtml(message.text)}</article>`;
}

/**
 * F13: this banner must render INSIDE the `#variables` container that
 * mutations swap — a fragment response from a save/delete/clear route is
 * exactly {@link renderVariablesTable}'s output, so if the banner lived
 * outside that div (as in the original design) it could never update after
 * a mutation.
 */
function renderMissingBanner(missing: string[]): string {
	if (missing.length === 0) return "";
	const names = missing
		.map((name) => `<code>${escapeHtml(name)}</code>`)
		.join(", ");
	return `<article role="alert" data-testid="readiness-banner">
		<strong>Your sessions are not ready to run.</strong>
		These required variables have no value yet: ${names}.
	</article>`;
}

/**
 * The delete control's CSRF token travels as a **request header** (R2-03).
 *
 * htmx lists `delete` in `methodsThatUseUrlParams`, so every parameter it
 * collects for a DELETE is appended to the URL rather than sent as a body. The
 * original control did `hx-include="#csrf"`, which put an 8-hour token in the
 * query string — into access logs and browser history — and the routes layer
 * refuses a query-string token by design, so the button also 403'd on every
 * real click. A header is the one transport that is both private and accepted.
 *
 * `hx-params="none"` is the belt to that braces: htmx folds in
 * `closest(elt, 'form')` for any non-GET verb, so wrapping this table in a
 * `<form>` later would otherwise sweep every hidden field — csrf included —
 * straight back into the URL this fix just cleaned up.
 *
 * The JSON is HTML-escaped, so no raw quote of either kind can terminate the
 * attribute early; the browser hands htmx the decoded text.
 */
function renderDeleteButton(name: string, csrfToken: string): string {
	const headers = escapeHtml(JSON.stringify({ "X-CSRF-Token": csrfToken }));
	return `<button type="button" class="secondary" hx-delete="/setup/variables/${encodeURIComponent(name)}" hx-target="#variables" hx-swap="outerHTML" hx-headers="${headers}" hx-params="none">Delete</button>`;
}

function renderRow(variable: VariableView, csrfToken: string): string {
	const name = escapeHtml(variable.name);
	const requiredBadge = variable.required
		? ' <small aria-label="required">required</small>'
		: "";
	// F22 (second part): a "clear this value" checkbox belongs only on a SET
	// required variable — there is nothing to clear on an unset one, and an
	// optional variable is removed with the delete button instead of being
	// saved as an explicit empty row.
	const action = variable.required
		? variable.isSet
			? `<label><input type="checkbox" name="clear:${name}"> Clear this value</label>`
			: ""
		: renderDeleteButton(variable.name, csrfToken);

	return `
	<tr>
		<td><code>${name}</code>${requiredBadge}</td>
		<td>${variable.isSet ? "Set" : "<em>Not set</em>"}</td>
		<td>
			<input type="password" name="value:${name}"
				autocomplete="off" spellcheck="false"
				placeholder="${variable.isSet ? "unchanged" : "enter a value"}"
				aria-label="Value for ${name}">
		</td>
		<td>${action}</td>
	</tr>`;
}

/**
 * Renders the table of variables plus its controls, wrapped in the
 * `#variables` container that every mutating route's fragment response
 * swaps. Hidden controls (`csrf`, `version`) carry opaque, server-issued
 * tokens — not secrets — so they are exempt from the "no value= attribute"
 * redaction rule that applies to the value/password inputs (F22).
 */
export function renderVariablesTable(model: SetupPageModel): string {
	const rows = model.variables
		.map((variable) => renderRow(variable, model.csrfToken))
		.join("");
	const versionField =
		model.versionToken === undefined
			? ""
			: `<input type="hidden" name="version" value="${escapeHtml(model.versionToken)}">`;
	// The value inputs, the hidden csrf/version fields, and the save button all
	// live inside ONE form posting to /setup/save, because that route reads
	// `value:<NAME>`, `clear:<NAME>`, `csrf`, and `version` from a single body.
	// Without this form the save route was implemented, routed, and tested but
	// completely unreachable from the page.
	//
	// The delete buttons sit inside this form too. That is safe only because
	// each carries `hx-params="none"` — otherwise htmx would fold every field
	// of the enclosing form, csrf and every typed password included, into the
	// DELETE query string (R2-03).
	return `<div id="variables">
	${renderMissingBanner(model.missingRequired)}
	<form hx-post="/setup/save" hx-target="#variables" hx-swap="outerHTML">
		<input type="hidden" id="csrf" name="csrf" value="${escapeHtml(model.csrfToken)}">
		${versionField}
		<table>
			<thead>
				<tr><th>Variable</th><th>Status</th><th>New value</th><th></th></tr>
			</thead>
			<tbody>${rows}</tbody>
		</table>
		<button type="submit">Save changes</button>
		<p><small>A blank field leaves the stored value unchanged.</small></p>
	</form>
	<hr>
	<form hx-post="/setup/variables" hx-target="#variables" hx-swap="outerHTML">
		<input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
		<label for="new-variable">Add an optional variable</label>
		<input type="text" id="new-variable" name="name" required
			pattern="[A-Za-z_][A-Za-z0-9_]*"
			autocomplete="off" spellcheck="false"
			placeholder="MY_TOOL_KEY">
		<button type="submit" class="secondary">Add variable</button>
	</form>
</div>`;
}

/* ------------------------------------------------------- session defaults -- */

/**
 * Copy for what changing a default actually does to work in flight.
 *
 * The variables form says *"applies to the next session that starts"*, and for
 * an affinity-pinned live session that is simply wrong: `resolveTarget`'s fast
 * path returns the already-bound device before `executorFor` is ever consulted,
 * so for an issue that already has a container there may be no next
 * `ensureDevice` at all — the old value survives for the life of that issue, not
 * for the life of one session. `docs/ROUTER.md` prescribes the remedy and the UI
 * has never mentioned it.
 */
const NEXT_SESSION_NOTE = `Applies to issues that start a container after you save. An issue that already has one keeps its current runner until the container is replaced — to move it now, run <code>cyrus router containers destroy &lt;issueKey&gt;</code> and re-prompt the issue.`;

/**
 * The runner/model picker: one `<select>`, grouped by runner, because naming a
 * model names the runner.
 *
 * Curated `<option>`s rather than a text box — see {@link RUNNER_CATALOG} for
 * why free text reintroduces exactly the failure this control exists to remove.
 */
export function renderDefaultsSection(model: SetupPageModel): string {
	const current = model.defaultRunner
		? encodeSelection(model.defaultRunner)
		: "";
	const groups = RUNNER_CATALOG.map((entry) => {
		const options = entry.models
			.map((option) => {
				const value = encodeSelection({
					runner: entry.runner,
					model: option.model,
				});
				const selected = value === current ? " selected" : "";
				return `<option value="${escapeHtml(value)}"${selected}>${escapeHtml(option.label)}</option>`;
			})
			.join("");
		return `<optgroup label="${escapeHtml(entry.label)}">${options}</optgroup>`;
	}).join("");

	return `<div id="session-defaults">
	${renderMessage(model.defaultsMessage)}
	<form hx-post="/setup/defaults" hx-target="#session-defaults" hx-swap="outerHTML">
		<input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
		<label for="default-runner">Default agent and model</label>
		<select id="default-runner" name="default_runner">
			<option value=""${current === "" ? " selected" : ""}>Router default</option>
			${groups}
		</select>
		<button type="submit" class="secondary">Save default</button>
		<p><small>${NEXT_SESSION_NOTE}</small></p>
		<p><small>A <code>[agent=…]</code> or <code>[model=…]</code> tag in an issue description, or an agent/model label on the issue, still overrides this for that issue.</small></p>
	</form>
</div>`;
}

/* ---------------------------------------------------------- codex account -- */

const CODEX_STATUS_TEXT: Record<CodexAccountView["status"], string> = {
	absent: "Not connected",
	connected: "Connected",
	expiring: "Connected — will be refreshed on the next container boot",
	"needs-attention": "Needs attention",
};

/**
 * The Codex account section: a paste box and a status row, never a password
 * input.
 *
 * The variables table's `<input type="password">` is the wrong shape here twice
 * over — an `auth.json` is a multi-KB JSON blob, and there is nothing about it a
 * user can usefully re-type. What they need to see is whether the credential
 * still works, which is what the status row is.
 */
export function renderCodexSection(model: SetupPageModel): string {
	const codex = model.codex;
	if (!codex) return "";
	const status = CODEX_STATUS_TEXT[codex.status];
	const updated =
		codex.updatedMs === undefined
			? ""
			: ` <small>(last refreshed ${escapeHtml(new Date(codex.updatedMs).toISOString())})</small>`;
	const error = codex.error
		? `<p role="alert"><small>${escapeHtml(codex.error)}</small></p>`
		: "";
	const disconnect =
		codex.status === "absent"
			? ""
			: `<form hx-post="/setup/codex/disconnect" hx-target="#codex-account" hx-swap="outerHTML">
			<input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
			<button type="submit" class="secondary">Disconnect</button>
		</form>`;

	return `<div id="codex-account">
	${renderMessage(model.codexMessage)}
	<p><strong>Codex account:</strong> ${escapeHtml(status)}${updated}</p>
	${error}
	<form hx-post="/setup/codex" hx-target="#codex-account" hx-swap="outerHTML">
		<input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
		<label for="codex-auth">Connect your ChatGPT subscription</label>
		<p><small>Run <code>codex login --device-auth</code> on your own machine, then paste the contents of <code>~/.codex/auth.json</code> here. Cyrus holds and refreshes it for you, and hands each container a fresh short-lived copy — so you never have to sign in from inside a session.</small></p>
		<textarea id="codex-auth" name="codex_auth_json" rows="4"
			autocomplete="off" spellcheck="false"
			placeholder="{ &quot;tokens&quot;: { … } }"></textarea>
		<button type="submit">Connect Codex</button>
	</form>
	${disconnect}
</div>`;
}

/**
 * F12: htmx 2.x's default `responseHandling` does not swap 4xx/5xx
 * responses — `htmx:responseError` fires and the DOM is left untouched. Every
 * planned 400 (bad field)/403 (domain denied)/409 (version conflict)
 * fragment, including a freshly reissued CSRF token inside it, would
 * otherwise be silently discarded, leaving a stale token in the page. This
 * handler is the documented seam (`htmx:beforeSwap`) for opting specific
 * error statuses back into swapping.
 */
// Bound to `document`, NOT `document.body`. This script tag sits in <head>, so
// it executes during head parsing while `document.body` is still null — and
// `defer` is ignored on inline scripts, so it cannot be deferred into place.
// `document.body.addEventListener` therefore threw a TypeError before the
// listener was ever registered, htmx kept its default of not swapping 4xx, and
// every error fragment was discarded in silence. htmx events bubble to
// `document`, which exists from the first byte, so this is equivalent at
// runtime and immune to where the tag ends up.
const BEFORE_SWAP_SCRIPT = `document.addEventListener("htmx:beforeSwap", (e) => {
	if ([400, 403, 409].includes(e.detail.xhr.status)) {
		e.detail.shouldSwap = true;
		e.detail.isError = false;
	}
});`;

/**
 * Renders the full page: sign-in identity, the readiness banner (via
 * {@link renderVariablesTable}, see F13), and the embedded table so first
 * paint needs no htmx round-trip.
 *
 * D5′ / F23: the copy below says "stored values are never displayed" — not
 * "values never travel to the browser". The latter is false: a *newly typed*
 * secret is held in the DOM and sent in a request body on save, which is
 * visible to extensions, devtools, and any request-body logging. The
 * narrower, true claim is that nothing this page ever fetched from storage
 * is echoed back to the browser.
 */
export function renderPage(model: SetupPageModel): string {
	// A fresh nonce per render lets the CSP allow exactly this one inline
	// script (no `unsafe-inline`) while still allowing the same-origin
	// `<script src>` for htmx via the `'self'` source expression.
	const nonce = randomBytes(16).toString("base64");
	const csp = [
		"default-src 'none'",
		"style-src 'self' 'unsafe-inline'",
		`script-src 'self' 'nonce-${nonce}'`,
		"img-src 'self'",
		// Same-origin XHR for htmx's POST to /setup/save. This meta policy and
		// the response header in routes.ts are enforced independently, so both
		// must allow it — permitting it in only one still blocks the save.
		"connect-src 'self'",
		"form-action 'self'",
		"frame-ancestors 'none'",
		"base-uri 'none'",
	].join("; ");

	return `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<meta http-equiv="Content-Security-Policy" content="${csp}">
	<title>Cyrus setup</title>
	<link rel="stylesheet" href="/setup/assets/pico.css">
	<script src="/setup/assets/htmx.js" defer></script>
	<script nonce="${nonce}">
		${BEFORE_SWAP_SCRIPT}
	</script>
</head>
<body>
	<main>
		<header>
			<h1>Cyrus setup</h1>
			<p>Signed in as <strong>${escapeHtml(model.email)}</strong> &middot; <a href="/setup/repositories">Repositories</a> &middot; <a href="/.auth/logout">Sign out</a></p>
		</header>
		${renderMessage(model.message)}
		<article>
			<h2>Session defaults</h2>
			${renderDefaultsSection(model)}
		</article>
		<article>
			<h2>Credentials</h2>
			<p><small>These environment variables are injected into the container that runs your Cyrus sessions. Stored values are never displayed — leave a field blank to keep the current value.</small></p>
			${renderVariablesTable(model)}
		</article>
		${model.codex ? `<article><h2>Codex account</h2>${renderCodexSection(model)}</article>` : ""}
	</main>
</body>
</html>`;
}
