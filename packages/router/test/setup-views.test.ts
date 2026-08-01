import { describe, expect, it } from "vitest";
import {
	escapeHtml,
	renderMessage,
	renderPage,
	renderVariablesTable,
	type SetupPageModel,
} from "../src/setup/views.js";

const model: SetupPageModel = {
	email: "alice@example.com",
	variables: [
		{ name: "CLAUDE_CODE_OAUTH_TOKEN", required: true, isSet: true },
		{ name: "GIT_TOKEN", required: true, isSet: false },
		{ name: "MY_TOOL_KEY", required: false, isSet: true },
	],
	missingRequired: ["GIT_TOKEN"],
	csrfToken: "tok.123",
};

/**
 * Extracts the `<tr>...</tr>` block whose first cell is exactly `name`.
 * Anchored on `<td><code>` so it can't match the readiness banner, which
 * also renders missing variable names inside a bare `<code>` (outside any
 * `<tr>`).
 */
function rowFor(html: string, name: string): string {
	const marker = `<td><code>${name}</code>`;
	const idx = html.indexOf(marker);
	if (idx === -1) throw new Error(`row not found for "${name}"`);
	const rowStart = html.lastIndexOf("<tr>", idx);
	const rowEnd = html.indexOf("</tr>", idx);
	if (rowStart === -1 || rowEnd === -1) {
		throw new Error(`malformed row markup around "${name}"`);
	}
	return html.slice(rowStart, rowEnd + "</tr>".length);
}

describe("escapeHtml", () => {
	it("escapes the five significant characters", () => {
		expect(escapeHtml(`<a href="x" data='y'>&</a>`)).toBe(
			"&lt;a href=&quot;x&quot; data=&#39;y&#39;&gt;&amp;&lt;/a&gt;",
		);
	});

	it("escapes ampersands before anything else", () => {
		expect(escapeHtml("&lt;")).toBe("&amp;lt;");
	});
});

describe("renderMessage", () => {
	it("renders nothing when there is no message", () => {
		expect(renderMessage(undefined)).toBe("");
	});

	it("renders the message text", () => {
		expect(renderMessage({ kind: "ok", text: "Saved" })).toContain("Saved");
	});

	it("escapes a hostile message", () => {
		const html = renderMessage({
			kind: "error",
			text: `<script>alert(1)</script>`,
		});
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});
});

describe("renderVariablesTable", () => {
	it("renders one row per variable, names included", () => {
		const html = renderVariablesTable(model);
		expect(html).toContain("CLAUDE_CODE_OAUTH_TOKEN");
		expect(html).toContain("GIT_TOKEN");
		expect(html).toContain("MY_TOOL_KEY");
	});

	it("marks required variables and does not offer to delete them", () => {
		const html = renderVariablesTable(model);
		expect(rowFor(html, "CLAUDE_CODE_OAUTH_TOKEN")).not.toContain("hx-delete");
		expect(rowFor(html, "GIT_TOKEN")).not.toContain("hx-delete");
	});

	it("offers to delete an optional variable via hx-delete", () => {
		const html = renderVariablesTable(model);
		expect(rowFor(html, "MY_TOOL_KEY")).toContain("hx-delete");
	});

	/**
	 * R2-03. The vendored htmx ships `methodsThatUseUrlParams:["get","delete"]`
	 * (pinned by a test in `setup-vendor.test.ts`), so **every parameter htmx
	 * collects for a DELETE is appended to the URL** rather than sent as a body.
	 * The original control did `hx-include="#csrf"`, which put the 8-hour CSRF
	 * token in the query string — where it lands in access logs and browser
	 * history, and where `requireMutation` deliberately refuses to read it, so
	 * the button also 403'd on every click in a real browser.
	 *
	 * The token therefore travels as a request HEADER, and the control must
	 * carry nothing that can contribute a URL parameter. `hx-params="none"` is
	 * belt-and-braces: htmx includes `closest(elt, 'form')` for any non-GET
	 * verb, so wrapping this table in a `<form>` later would otherwise sweep
	 * every hidden field — csrf included — back into the URL.
	 */
	describe("delete control CSRF transport (R2-03)", () => {
		it("carries the token in an X-CSRF-Token header via hx-headers", () => {
			const row = rowFor(renderVariablesTable(model), "MY_TOOL_KEY");
			expect(row).toMatch(/hx-headers="[^"]*X-CSRF-Token[^"]*"/);
			expect(row).toContain("tok.123");
		});

		it("parses as JSON once the browser has decoded the attribute", () => {
			const row = rowFor(renderVariablesTable(model), "MY_TOOL_KEY");
			const raw = row.match(/hx-headers="([^"]*)"/)?.[1] ?? "";
			// The attribute is HTML-escaped, so no raw quote of either kind can
			// terminate it early; htmx sees the decoded text.
			const decoded = raw
				.replaceAll("&quot;", '"')
				.replaceAll("&#39;", "'")
				.replaceAll("&lt;", "<")
				.replaceAll("&gt;", ">")
				.replaceAll("&amp;", "&");
			expect(JSON.parse(decoded)).toEqual({ "X-CSRF-Token": "tok.123" });
		});

		it("carries no attribute that would place a parameter in the delete URL", () => {
			const row = rowFor(renderVariablesTable(model), "MY_TOOL_KEY");
			expect(row).not.toContain("hx-include");
			expect(row).not.toContain("hx-vals");
			expect(row).toContain('hx-params="none"');
			expect(row).not.toMatch(/hx-delete="[^"]*[?&]/);
		});

		it("escapes a hostile csrf token inside the header attribute", () => {
			const row = rowFor(
				renderVariablesTable({
					...model,
					csrfToken: `"><script>alert(1)</script>`,
				}),
				"MY_TOOL_KEY",
			);
			expect(row).not.toContain("<script>alert(1)</script>");
			expect(row).toContain("&lt;script&gt;");
		});
	});

	it("distinguishes set from unset without revealing anything", () => {
		const html = renderVariablesTable(model);
		expect(rowFor(html, "GIT_TOKEN")).toContain("Not set");
		expect(rowFor(html, "MY_TOOL_KEY")).toContain("Set");
	});

	it("escapes a hostile variable name", () => {
		const html = renderVariablesTable({
			...model,
			variables: [
				{
					name: `X"><script>alert(1)</script>`,
					required: false,
					isSet: false,
				},
			],
		});
		expect(html).not.toContain("<script>alert(1)</script>");
		expect(html).toContain("&lt;script&gt;");
	});

	// F22 (first part): the original spec asserted BOTH
	// `not.toMatch(/value="[^"]+"/)` over the whole table AND
	// `toContain('value="tok.123"')` for the csrf hidden field — mutually
	// exclusive. Scope the redaction check to value/password inputs only,
	// and assert hidden-control values separately.
	describe("value redaction (F22)", () => {
		it("renders no value attribute on any password input", () => {
			const html = renderVariablesTable(model);
			const passwordInputs = html.match(/<input[^>]*type="password"[^>]*>/g);
			expect(passwordInputs).not.toBeNull();
			expect(passwordInputs?.length).toBeGreaterThan(0);
			for (const input of passwordInputs ?? []) {
				expect(input).not.toMatch(/\svalue=/);
			}
		});

		it("embeds the csrf token as a hidden field (hidden controls are not redacted)", () => {
			const html = renderVariablesTable(model);
			expect(html).toMatch(
				/<input type="hidden" id="csrf"[^>]*value="tok\.123"/,
			);
		});
	});

	// F8: a render-time opaque version token, carried through as an inert
	// hidden field. The routes layer (a later wave) mints and verifies it.
	describe("version token (F8)", () => {
		it("embeds the version token as a hidden field when provided", () => {
			const html = renderVariablesTable({
				...model,
				versionToken: "etag-abc123",
			});
			expect(html).toMatch(
				/<input type="hidden" name="version" value="etag-abc123">/,
			);
		});

		it("omits the version field entirely when no version token is provided", () => {
			const html = renderVariablesTable(model);
			expect(html).not.toContain('name="version"');
		});

		it("escapes a hostile version token", () => {
			const html = renderVariablesTable({
				...model,
				versionToken: `"><script>alert(1)</script>`,
			});
			expect(html).not.toContain("<script>alert(1)</script>");
		});
	});

	// F22 (second part): a "clear this value" checkbox belongs only on a set
	// REQUIRED variable. Required-but-unset gets nothing (there is nothing to
	// clear); optional variables are removed via the delete button instead,
	// never via a save-an-empty-row checkbox.
	describe("clear checkbox scoping (F22)", () => {
		it("renders a clear checkbox for a set required variable", () => {
			const html = renderVariablesTable(model);
			expect(rowFor(html, "CLAUDE_CODE_OAUTH_TOKEN")).toContain(
				"clear:CLAUDE_CODE_OAUTH_TOKEN",
			);
		});

		it("does not render a clear checkbox for an unset required variable", () => {
			const html = renderVariablesTable(model);
			expect(rowFor(html, "GIT_TOKEN")).not.toContain("clear:GIT_TOKEN");
		});

		it("does not render a clear checkbox for a set OPTIONAL variable", () => {
			const html = renderVariablesTable(model);
			expect(rowFor(html, "MY_TOOL_KEY")).not.toContain("clear:MY_TOOL_KEY");
		});
	});

	// F13: the readiness banner must live inside the #variables container so
	// an htmx swap of that element alone keeps it up to date.
	describe("readiness banner placement (F13)", () => {
		it("renders inside the #variables container when a required value is cleared/unset", () => {
			const html = renderVariablesTable(model); // GIT_TOKEN is missing
			expect(html.startsWith('<div id="variables">')).toBe(true);
			expect(html).toMatch(/not ready to run/i);
		});

		it("omits the banner when every required value is set", () => {
			const html = renderVariablesTable({ ...model, missingRequired: [] });
			expect(html).not.toMatch(/not ready to run/i);
		});
	});
});

describe("renderPage", () => {
	it("includes the signed-in email and a sign-out link", () => {
		const html = renderPage(model);
		expect(html).toContain("alice@example.com");
		expect(html).toContain("/.auth/logout");
	});

	it("escapes a hostile email", () => {
		const html = renderPage({
			...model,
			email: `<img src=x onerror=alert(1)>`,
		});
		expect(html).not.toContain("<img src=x onerror=alert(1)>");
		expect(html).toContain("&lt;img");
	});

	it("references only same-origin assets", () => {
		const html = renderPage(model);
		expect(html).toContain("/setup/assets/pico.css");
		expect(html).toContain("/setup/assets/htmx.js");
		expect(html).not.toMatch(/https?:\/\/[^"']*(unpkg|cdn|jsdelivr)/i);
	});

	it("includes a strict same-origin CSP meta tag", () => {
		const html = renderPage(model);
		const match = html.match(
			/<meta http-equiv="Content-Security-Policy" content="([^"]*)">/,
		);
		expect(match).not.toBeNull();
		const csp = match?.[1] ?? "";
		expect(csp).toContain("default-src 'none'");
		expect(csp).toContain("script-src 'self'");
		expect(csp).toContain("frame-ancestors 'none'");
		expect(csp).not.toMatch(/https?:\/\//);
	});

	// F12: htmx 2.x does not swap 4xx/5xx responses by default, so every
	// planned 400/403/409 fragment (including a fresh CSRF token) would be
	// silently discarded without this handler.
	it("includes the htmx:beforeSwap handler so 400/403/409 fragments render (F12)", () => {
		const html = renderPage(model);
		expect(html).toContain("htmx:beforeSwap");
		expect(html).toContain("[400, 403, 409].includes(e.detail.xhr.status)");
		expect(html).toContain("e.detail.shouldSwap = true;");
		expect(html).toContain("e.detail.isError = false;");
	});

	it("serves the beforeSwap handler as an inline script permitted by the CSP nonce", () => {
		const html = renderPage(model);
		const nonceMatch = html.match(/'nonce-([A-Za-z0-9+/=]+)'/);
		expect(nonceMatch).not.toBeNull();
		const nonce = nonceMatch?.[1] ?? "";
		expect(nonce.length).toBeGreaterThan(0);
		expect(html).toContain(`<script nonce="${nonce}">`);
	});

	it("warns when a required variable is unset", () => {
		expect(renderPage(model)).toMatch(/GIT_TOKEN/);
		expect(renderPage(model)).toMatch(/not.*ready|missing/i);
	});

	it("shows no warning when nothing is missing", () => {
		const html = renderPage({ ...model, missingRequired: [] });
		expect(html).not.toMatch(/not ready/i);
	});

	it("embeds the table so the first paint needs no htmx request", () => {
		expect(renderPage(model)).toContain("MY_TOOL_KEY");
	});

	it("embeds exactly the renderVariablesTable fragment, so an htmx swap of #variables covers everything inside it", () => {
		const html = renderPage(model);
		expect(html).toContain(renderVariablesTable(model));
	});

	it("renders a message banner when one is present", () => {
		const html = renderPage({
			...model,
			message: { kind: "error", text: "Something went wrong" },
		});
		expect(html).toContain("Something went wrong");
	});

	// D5' / F23: "values never travel to the browser" is false — a newly
	// typed secret IS sent in a request body. The true, narrower claim is
	// that a STORED value is never returned or rendered.
	describe("threat-model copy (F23 / D5')", () => {
		it("uses the corrected claim wording", () => {
			expect(renderPage(model)).toMatch(/stored values are never displayed/i);
		});

		it("never claims values never travel to the browser", () => {
			expect(renderPage(model)).not.toMatch(
				/values? never travels? to the browser/i,
			);
		});
	});
});

describe("the page can actually reach every implemented route", () => {
	// Regression guard for a real gap: POST /setup/save and POST
	// /setup/variables were implemented, routed, and server-tested while the
	// rendered page contained no control able to submit either. Server-side
	// route tests cannot catch that — only asserting on the markup can.
	const model: SetupPageModel = {
		email: "alice@example.com",
		variables: [
			{ name: "CLAUDE_CODE_OAUTH_TOKEN", required: true, isSet: true },
			{ name: "MY_TOOL_KEY", required: false, isSet: true },
		],
		missingRequired: [],
		csrfToken: "tok.123",
		versionToken: "ver.456",
	};

	it("submits the value inputs to /setup/save", () => {
		const html = renderVariablesTable(model);
		expect(html).toMatch(/<form[^>]*hx-post="\/setup\/save"/);
		expect(html).toMatch(/<button[^>]*type="submit"/);
	});

	it("carries csrf and the render-time version inside the save form", () => {
		const html = renderVariablesTable(model);
		const form = html.slice(html.indexOf('hx-post="/setup/save"'));
		expect(form).toContain('name="csrf"');
		expect(form).toContain('name="version"');
		expect(form).toContain('value="ver.456"');
		// The value inputs must be inside it, or a save submits nothing.
		expect(form).toContain('name="value:CLAUDE_CODE_OAUTH_TOKEN"');
	});

	it("offers a control that posts a new variable name to /setup/variables", () => {
		const html = renderVariablesTable(model);
		expect(html).toMatch(/<form[^>]*hx-post="\/setup\/variables"/);
		expect(html).toMatch(/<input[^>]*name="name"/);
	});

	it("keeps delete out of the enclosing form's parameter sweep", () => {
		// Delete now sits inside the save form. Without hx-params="none" htmx
		// would fold csrf, version, and every typed password into the DELETE
		// URL — reintroducing R2-03 by a different route.
		const html = renderVariablesTable(model);
		const del = html.slice(html.indexOf("hx-delete"));
		expect(del).toContain('hx-params="none"');
	});
});
