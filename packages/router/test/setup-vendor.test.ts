import { describe, expect, it } from "vitest";
import { HTMX_JS } from "../src/setup/vendor/htmx.js";
import { PICO_CSS } from "../src/setup/vendor/pico.js";

/**
 * These constants are served to the browser as `/setup/assets/pico.css` and
 * `/setup/assets/htmx.js` (see `views.ts`). ACA egress is deny-by-default,
 * so anything in here that reaches out to a real network origin at render
 * or execution time — a CDN `@import`, a `url()` pointing off-host, a
 * `<script src>` — would silently fail in production. That is the property
 * this file exists to guard; see `scripts/vendor-setup-assets.mjs` and
 * docs/superpowers/plans/2026-08-01-setup-management-ui.md ("Why assets are
 * vendored as TypeScript").
 */

/**
 * Finds substrings that would make the browser (or a CSS/JS parser) issue a
 * network request to an external origin. A plain `source.includes("http://")`
 * check is too strong here: both vendored files legitimately contain inert
 * `http://`/`https://` text that is never fetched — Pico's license-comment
 * attribution URL and the `xmlns="http://www.w3.org/2000/svg"` namespace
 * strings embedded inside its inline `data:image/svg+xml` icons. Only flag
 * patterns that actually trigger a load.
 */
function findFetchTriggeringReferences(source: string): string[] {
	const patterns = [
		/@import\b/gi,
		// A CSS/JS url() whose target is a real scheme or protocol-relative
		// origin, as opposed to an embedded `data:` URI.
		/url\(\s*["']?(?:https?:)?\/\/[^"')]*/gi,
		/<script[^>]+src\s*=\s*["']?https?:/gi,
		/<link[^>]+href\s*=\s*["']?https?:/gi,
		/\/\/unpkg\.com/gi,
		/\/\/cdn\./gi,
	];
	return patterns.flatMap((pattern) => source.match(pattern) ?? []);
}

describe("setup vendor assets", () => {
	it("PICO_CSS is non-empty", () => {
		expect(PICO_CSS.length).toBeGreaterThan(0);
	});

	it("HTMX_JS is non-empty", () => {
		expect(HTMX_JS.length).toBeGreaterThan(0);
	});

	it("PICO_CSS contains recognisable CSS and no script tag", () => {
		expect(PICO_CSS).toMatch(/[a-zA-Z-]+\s*:\s*[^;{}]+;/);
		expect(PICO_CSS).toContain(":root");
		expect(PICO_CSS.toLowerCase()).not.toContain("<script");
	});

	it("HTMX_JS mentions htmx", () => {
		expect(HTMX_JS.toLowerCase()).toContain("htmx");
	});

	/**
	 * R2-03. This one line of htmx configuration is why the delete control in
	 * `views.ts` sends its CSRF token as a header: for these verbs htmx appends
	 * everything it collects to the URL instead of sending a request body, and
	 * `requireMutation` refuses a query-string token by design. If a future
	 * vendoring bump changes this list, revisit that control.
	 */
	it("still treats DELETE as a URL-parameter method", () => {
		expect(HTMX_JS).toContain('methodsThatUseUrlParams:["get","delete"]');
	});

	it("supports the hx-headers attribute the delete control relies on", () => {
		expect(HTMX_JS).toContain("hx-headers");
	});

	it("neither asset embeds a sourceMappingURL reference", () => {
		expect(PICO_CSS).not.toContain("sourceMappingURL");
		expect(HTMX_JS).not.toContain("sourceMappingURL");
	});

	// Load-bearing: a regression here means the ACA sandbox's deny-by-default
	// egress would silently break this asset in production.
	it("PICO_CSS never references an external origin in a way that would trigger a fetch", () => {
		expect(findFetchTriggeringReferences(PICO_CSS)).toEqual([]);
	});

	it("HTMX_JS never references an external origin in a way that would trigger a fetch", () => {
		expect(findFetchTriggeringReferences(HTMX_JS)).toEqual([]);
	});
});
