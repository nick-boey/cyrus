import { randomBytes } from "node:crypto";
import { parseAssociations } from "cyrus-core";
import { escapeHtml, renderMessage, type SetupMessage } from "./views.js";

/**
 * Pure HTML rendering for `/setup/repositories`. No I/O, no Fastify — every
 * function is a straight string transform, so it is unit-testable without a
 * server. Mirrors `views.ts`, and inherits its two invariants: every
 * interpolated value passes through {@link escapeHtml}, and the full page ships
 * a nonce-scoped CSP rather than `unsafe-inline`.
 *
 * Unlike the variables page there is nothing secret here — repository names and
 * slugs are rendered back verbatim, which is what makes editing possible.
 */

/** One row in the repositories table. */
export interface RepositoryView {
	name: string;
	githubSlug: string;
	baseBranch: string;
	/** The `p=`/`t=` string, already formatted by `formatAssociations`. */
	associations: string;
	isDefault: boolean;
}

export interface RepositoriesPageModel {
	email: string;
	repositories: RepositoryView[];
	/** Workspace ids the router serves. One means the field is auto-filled. */
	workspaceIds: string[];
	/** Human-readable warnings from {@link findAmbiguities}. */
	ambiguities: string[];
	csrfToken: string;
	/** Render-time version token, for conflict detection on save. */
	versionToken?: string;
	message?: SetupMessage;
}

/**
 * Surfaces, at configuration time, the ambiguities that would otherwise only
 * appear mid-issue as an elicitation the user has to answer.
 *
 * Never throws: a malformed association string is already reported by the save
 * path, and a banner renderer that can throw would take the whole page down.
 */
export function findAmbiguities(repositories: RepositoryView[]): string[] {
	const warnings: string[] = [];
	const projects = new Map<string, { name: string; repos: string[] }>();
	const teams = new Map<string, { name: string; repos: string[] }>();

	for (const repo of repositories) {
		let parsed: { projectKeys: string[]; teamKeys: string[] };
		try {
			parsed = parseAssociations(repo.associations);
		} catch {
			continue;
		}
		for (const project of parsed.projectKeys) {
			const key = project.toLowerCase();
			const entry = projects.get(key) ?? { name: project, repos: [] };
			entry.repos.push(repo.name);
			projects.set(key, entry);
		}
		for (const team of parsed.teamKeys) {
			const key = team.toLowerCase();
			const entry = teams.get(key) ?? { name: team, repos: [] };
			entry.repos.push(repo.name);
			teams.set(key, entry);
		}
	}

	const describe = (
		entries: Map<string, { name: string; repos: string[] }>,
		kind: string,
	): void => {
		for (const { name, repos } of entries.values()) {
			if (repos.length < 2) continue;
			const quoted = repos.map((repo) => `"${repo}"`);
			const list =
				quoted.length === 2
					? quoted.join(" and ")
					: `${quoted.slice(0, -1).join(", ")}, and ${quoted.at(-1)}`;
			const verb = repos.length > 2 ? "all claim" : "both claim";
			warnings.push(
				`Repositories ${list} ${verb} ${kind} "${name}" — Cyrus will have to ask which one to use.`,
			);
		}
	};
	describe(projects, "project");
	describe(teams, "team");

	const defaults = repositories.filter((repo) => repo.isDefault);
	if (defaults.length > 1) {
		warnings.push(
			`You have more than one default repository (${defaults
				.map((repo) => `"${repo.name}"`)
				.join(", ")}). Cyrus will ask which one to use instead of picking.`,
		);
	}
	return warnings;
}

function renderAmbiguityBanner(warnings: string[]): string {
	if (warnings.length === 0) return "";
	const items = warnings
		.map((warning) => `<li>${escapeHtml(warning)}</li>`)
		.join("");
	return `<article role="alert" data-testid="ambiguity-banner">
		<strong>Some issues will need a manual choice.</strong>
		<ul>${items}</ul>
	</article>`;
}

/**
 * The delete control's CSRF token travels as a **request header**, exactly as
 * in `views.ts`: htmx appends collected parameters to the URL for DELETE, and
 * the routes layer refuses a query-string token by design. `hx-params="none"`
 * stops the enclosing form's fields — csrf included — being swept into the URL.
 */
function renderDeleteButton(name: string, csrfToken: string): string {
	const headers = escapeHtml(JSON.stringify({ "X-CSRF-Token": csrfToken }));
	return `<button type="button" class="secondary" hx-delete="/setup/repositories/${encodeURIComponent(name)}" hx-target="#repositories" hx-swap="outerHTML" hx-headers="${headers}" hx-params="none">Delete</button>`;
}

function renderRow(repo: RepositoryView, csrfToken: string): string {
	const name = escapeHtml(repo.name);
	return `
	<tr>
		<td><code>${name}</code><input type="hidden" name="repo:${name}" value="1"></td>
		<td><input type="text" name="slug:${name}" value="${escapeHtml(repo.githubSlug)}"
			autocomplete="off" spellcheck="false" aria-label="GitHub slug for ${name}"></td>
		<td><input type="text" name="branch:${name}" value="${escapeHtml(repo.baseBranch)}"
			autocomplete="off" spellcheck="false" aria-label="Base branch for ${name}"></td>
		<td><input type="text" name="assoc:${name}" value="${escapeHtml(repo.associations)}"
			autocomplete="off" spellcheck="false" placeholder="p=Project,t=TEAM"
			aria-label="Associations for ${name}"></td>
		<td><input type="radio" name="isDefault" value="${name}"${repo.isDefault ? " checked" : ""}
			aria-label="Make ${name} the default"></td>
		<td>${renderDeleteButton(repo.name, csrfToken)}</td>
	</tr>`;
}

function renderWorkspaceField(workspaceIds: string[]): string {
	const first = workspaceIds[0];
	if (workspaceIds.length === 1 && first) {
		// The Linear token binds the workspace, so with one configured there is
		// nothing to choose and a select would be a field that can only be wrong.
		return `<input type="hidden" name="linearWorkspaceId" value="${escapeHtml(first)}">`;
	}
	const options = workspaceIds
		.map((id) => `<option value="${escapeHtml(id)}">${escapeHtml(id)}</option>`)
		.join("");
	return `<label for="new-workspace">Linear workspace</label>
		<select id="new-workspace" name="linearWorkspaceId" required>${options}</select>`;
}

export function renderRepositoriesTable(model: RepositoriesPageModel): string {
	const rows = model.repositories
		.map((repo) => renderRow(repo, model.csrfToken))
		.join("");
	const versionField =
		model.versionToken === undefined
			? ""
			: `<input type="hidden" name="version" value="${escapeHtml(model.versionToken)}">`;

	return `<div id="repositories">
	${renderAmbiguityBanner(model.ambiguities)}
	<form hx-post="/setup/repositories/save" hx-target="#repositories" hx-swap="outerHTML">
		<input type="hidden" id="repo-csrf" name="csrf" value="${escapeHtml(model.csrfToken)}">
		${versionField}
		<table>
			<thead>
				<tr><th>Name</th><th>GitHub slug</th><th>Base branch</th><th>Associations</th><th>Default</th><th></th></tr>
			</thead>
			<tbody>${rows}</tbody>
		</table>
		<button type="submit">Save changes</button>
		<p><small>Associations use <code>p=</code> for a Linear project name and <code>t=</code> for a team key, both repeatable — for example <code>p=Platform,p=Billing,t=NOR</code>. Quote a value that contains a comma.</small></p>
	</form>
	<hr>
	<form hx-post="/setup/repositories" hx-target="#repositories" hx-swap="outerHTML">
		<input type="hidden" name="csrf" value="${escapeHtml(model.csrfToken)}">
		<label for="new-repo-name">Repository name</label>
		<input type="text" id="new-repo-name" name="name" required
			pattern="[A-Za-z0-9][A-Za-z0-9._\\-]{0,63}"
			autocomplete="off" spellcheck="false" placeholder="cyrus-api">
		<label for="new-repo-slug">GitHub slug</label>
		<input type="text" id="new-repo-slug" name="githubSlug" required
			autocomplete="off" spellcheck="false" placeholder="acme/cyrus-api">
		<label for="new-repo-branch">Base branch</label>
		<input type="text" id="new-repo-branch" name="baseBranch"
			autocomplete="off" spellcheck="false" placeholder="main">
		<label for="new-repo-assoc">Associations</label>
		<input type="text" id="new-repo-assoc" name="associations"
			autocomplete="off" spellcheck="false" placeholder="p=Platform,t=NOR">
		${renderWorkspaceField(model.workspaceIds)}
		<button type="submit" class="secondary">Add repository</button>
	</form>
</div>`;
}

/** Kept byte-identical in intent to `views.ts`'s handler — see the note there. */
const BEFORE_SWAP_SCRIPT = `document.addEventListener("htmx:beforeSwap", (e) => {
	if ([400, 403, 409].includes(e.detail.xhr.status)) {
		e.detail.shouldSwap = true;
		e.detail.isError = false;
	}
});`;

export function renderRepositoriesPage(model: RepositoriesPageModel): string {
	const nonce = randomBytes(16).toString("base64");
	const csp = [
		"default-src 'none'",
		"style-src 'self' 'unsafe-inline'",
		`script-src 'self' 'nonce-${nonce}'`,
		"img-src 'self'",
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
	<title>Cyrus repositories</title>
	<link rel="stylesheet" href="/setup/assets/pico.css">
	<script src="/setup/assets/htmx.js" defer></script>
	<script nonce="${nonce}">
		${BEFORE_SWAP_SCRIPT}
	</script>
</head>
<body>
	<main>
		<header>
			<h1>Cyrus repositories</h1>
			<p>Signed in as <strong>${escapeHtml(model.email)}</strong> &middot; <a href="/setup">Environment variables</a> &middot; <a href="/.auth/logout">Sign out</a></p>
		</header>
		${renderMessage(model.message)}
		<p><small>Cyrus clones one of these into each issue's workspace. It picks by <code>[repo=…]</code> in the issue description first, then routing labels, then project, then team, and finally the default.</small></p>
		${renderRepositoriesTable(model)}
	</main>
</body>
</html>`;
}
