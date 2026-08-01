import { randomBytes } from "node:crypto";

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

function renderRow(variable: VariableView): string {
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
		: `<button type="button" class="secondary" hx-delete="/setup/variables/${encodeURIComponent(variable.name)}" hx-target="#variables" hx-swap="outerHTML" hx-include="#csrf">Delete</button>`;

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
	const rows = model.variables.map(renderRow).join("");
	const versionField =
		model.versionToken === undefined
			? ""
			: `<input type="hidden" name="version" value="${escapeHtml(model.versionToken)}">`;
	return `<div id="variables">
	${renderMissingBanner(model.missingRequired)}
	<input type="hidden" id="csrf" name="csrf" value="${escapeHtml(model.csrfToken)}">
	${versionField}
	<table>
		<thead>
			<tr><th>Variable</th><th>Status</th><th>New value</th><th></th></tr>
		</thead>
		<tbody>${rows}</tbody>
	</table>
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
const BEFORE_SWAP_SCRIPT = `document.body.addEventListener("htmx:beforeSwap", (e) => {
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
			<p>Signed in as <strong>${escapeHtml(model.email)}</strong> &middot; <a href="/.auth/logout">Sign out</a></p>
		</header>
		${renderMessage(model.message)}
		<p><small>These environment variables are injected into the container that runs your Cyrus sessions. Stored values are never displayed — leave a field blank to keep the current value.</small></p>
		${renderVariablesTable(model)}
	</main>
</body>
</html>`;
}
