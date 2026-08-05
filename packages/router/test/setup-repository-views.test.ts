import { describe, expect, it } from "vitest";
import {
	findAmbiguities,
	type RepositoriesPageModel,
	renderRepositoriesPage,
	renderRepositoriesTable,
} from "../src/setup/repositoryViews.js";

const MODEL: RepositoriesPageModel = {
	email: "alice@example.com",
	repositories: [
		{
			name: "cyrus-api",
			githubSlug: "acme/cyrus-api",
			baseBranch: "main",
			associations: "p=Platform,t=NOR",
			isDefault: true,
		},
		{
			name: "cyrus-web",
			githubSlug: "acme/cyrus-web",
			baseBranch: "main",
			associations: "t=WEB",
			isDefault: false,
		},
	],
	workspaceIds: ["ws-1"],
	ambiguities: [],
	csrfToken: "csrf-token",
	versionToken: "version-token",
};

describe("renderRepositoriesTable", () => {
	it("renders one row per repository inside the swappable container", () => {
		const html = renderRepositoriesTable(MODEL);
		expect(html).toContain('<div id="repositories">');
		expect(html).toContain("cyrus-api");
		expect(html).toContain("acme/cyrus-web");
		expect(html).toContain('value="p=Platform,t=NOR"');
	});

	it("marks exactly one radio as the default", () => {
		const html = renderRepositoriesTable(MODEL);
		const checked = html.match(/name="isDefault"[^>]*checked/g) ?? [];
		expect(checked).toHaveLength(1);
		expect(html).toContain('value="cyrus-api"');
	});

	it("carries the CSRF token as a header on delete, never in the URL", () => {
		const html = renderRepositoriesTable(MODEL);
		expect(html).toContain('hx-delete="/setup/repositories/cyrus-web"');
		expect(html).toContain("X-CSRF-Token");
		expect(html).toContain('hx-params="none"');
		expect(html).not.toContain("?csrf=");
	});

	it("includes the version token as a hidden field", () => {
		expect(renderRepositoriesTable(MODEL)).toContain(
			'<input type="hidden" name="version" value="version-token">',
		);
	});

	it("omits the version field when there is no version token", () => {
		const { versionToken: _drop, ...rest } = MODEL;
		expect(renderRepositoriesTable(rest)).not.toContain('name="version"');
	});

	it("renders an ambiguity warning when one is reported", () => {
		const html = renderRepositoriesTable({
			...MODEL,
			ambiguities: ['Two repositories claim project "Platform"'],
		});
		expect(html).toContain('data-testid="ambiguity-banner"');
		expect(html).toContain("Two repositories claim project");
	});

	it("escapes every interpolated value", () => {
		const html = renderRepositoriesTable({
			...MODEL,
			repositories: [
				{
					name: "evil",
					githubSlug: '"><script>alert(1)</script>',
					baseBranch: "main",
					associations: "p=<b>x</b>",
					isDefault: false,
				},
			],
		});
		expect(html).not.toContain("<script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;b&gt;");
	});

	it("hides the workspace selector when the router serves one workspace", () => {
		const html = renderRepositoriesTable(MODEL);
		expect(html).toContain(
			'<input type="hidden" name="linearWorkspaceId" value="ws-1">',
		);
		expect(html).not.toContain("<select");
	});

	it("offers a workspace selector when the router serves several", () => {
		const html = renderRepositoriesTable({
			...MODEL,
			workspaceIds: ["ws-1", "ws-2"],
		});
		expect(html).toContain("<select");
		expect(html).toContain("ws-2");
	});
});

describe("renderRepositoriesPage", () => {
	it("emits a nonce-scoped CSP with no unsafe-inline for scripts", () => {
		const html = renderRepositoriesPage(MODEL);
		expect(html).toMatch(/script-src 'self' 'nonce-[^']+'/);
		expect(html).not.toContain("script-src 'self' 'unsafe-inline'");
	});

	it("links back to the variables page", () => {
		expect(renderRepositoriesPage(MODEL)).toContain('href="/setup"');
	});
});

describe("findAmbiguities", () => {
	it("reports two repositories claiming the same project, case-insensitively", () => {
		expect(
			findAmbiguities([
				{
					...MODEL.repositories[0]!,
					name: "a",
					associations: "p=Platform",
					isDefault: false,
				},
				{
					...MODEL.repositories[0]!,
					name: "b",
					associations: "p=platform",
					isDefault: false,
				},
			]),
		).toEqual([
			'Repositories "a" and "b" both claim project "Platform" — Cyrus will have to ask which one to use.',
		]);
	});

	it("reports two repositories claiming the same team", () => {
		expect(
			findAmbiguities([
				{ ...MODEL.repositories[0]!, name: "a", associations: "t=NOR" },
				{ ...MODEL.repositories[0]!, name: "b", associations: "t=NOR" },
			])[0],
		).toContain('both claim team "NOR"');
	});

	it("reports more than one default", () => {
		expect(
			findAmbiguities([
				{
					...MODEL.repositories[0]!,
					name: "a",
					isDefault: true,
					associations: "",
				},
				{
					...MODEL.repositories[0]!,
					name: "b",
					isDefault: true,
					associations: "",
				},
			])[0],
		).toContain("more than one default");
	});

	it("is silent for a well-formed registry", () => {
		expect(findAmbiguities(MODEL.repositories)).toEqual([]);
	});

	it("ignores an unparseable association string rather than throwing", () => {
		expect(() =>
			findAmbiguities([{ ...MODEL.repositories[0]!, associations: "p=" }]),
		).not.toThrow();
	});
});
