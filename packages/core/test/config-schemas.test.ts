import { describe, expect, it } from "vitest";
import { EdgeConfigSchema } from "../src/config-schemas.js";

const baseRepository = {
	id: "repo-1",
	name: "Repo 1",
	repositoryPath: "/path/to/repo",
	baseBranch: "main",
	workspaceBaseDir: "/workspaces",
};

describe("EdgeConfigSchema", () => {
	it("accepts strict MCP configuration as a top-level boolean", () => {
		const enabled = EdgeConfigSchema.parse({
			repositories: [baseRepository],
			strictMcpConfig: true,
		});
		const disabled = EdgeConfigSchema.parse({
			repositories: [baseRepository],
			strictMcpConfig: false,
		});

		expect(enabled.strictMcpConfig).toBe(true);
		expect(disabled.strictMcpConfig).toBe(false);
	});

	it("accepts arbitrary JSON-compatible OpenCode config at global and repository levels", () => {
		const config = {
			repositories: [
				{
					...baseRepository,
					opencode: {
						config: {
							model: "anthropic/claude-sonnet-4.5",
							disableCache: false,
							maxTokens: 12000,
							provider: null,
							experimental: {
								tools: ["bash", { name: "linear", enabled: true }],
							},
						},
					},
				},
			],
			opencode: {
				config: {
					theme: "system",
					autoshare: true,
					agent: {
						build: {
							description: "Build agent",
							temperature: 0.2,
						},
					},
					mcp: ["linear", "github"],
				},
			},
		};

		const result = EdgeConfigSchema.safeParse(config);

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.opencode?.config).toEqual(config.opencode.config);
			expect(result.data.repositories[0]?.opencode?.config).toEqual(
				config.repositories[0].opencode.config,
			);
		}
	});

	it("rejects non-object OpenCode config at global and repository levels", () => {
		const globalResult = EdgeConfigSchema.safeParse({
			repositories: [baseRepository],
			opencode: { config: "anthropic/claude-sonnet-4.5" },
		});
		const repositoryResult = EdgeConfigSchema.safeParse({
			repositories: [
				{
					...baseRepository,
					opencode: { config: ["not", "an", "object"] },
				},
			],
		});

		expect(globalResult.success).toBe(false);
		expect(repositoryResult.success).toBe(false);
	});

	it("accepts named operator connections for both auth kinds", () => {
		const result = EdgeConfigSchema.safeParse({
			repositories: [baseRepository],
			operatorConnections: {
				prod: {
					url: "https://router.example.com",
					auth: {
						kind: "entra",
						tenantId: "11111111-1111-1111-1111-111111111111",
						audience: "api://cyrus-router",
					},
				},
				dev: {
					url: "http://localhost:8787",
					auth: { kind: "local", tokenEnv: "CYRUS_DEV_OPERATOR_TOKEN" },
				},
			},
		});

		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.operatorConnections?.prod?.auth).toEqual({
				kind: "entra",
				tenantId: "11111111-1111-1111-1111-111111111111",
				audience: "api://cyrus-router",
			});
			expect(result.data.operatorConnections?.dev?.auth).toEqual({
				kind: "local",
				tokenEnv: "CYRUS_DEV_OPERATOR_TOKEN",
			});
		}
	});

	it("refuses to persist an operator token alongside a connection", () => {
		// A stored connection is credential-free by construction: `local` records
		// the NAME of an env var, never its value. Someone reaching for the
		// obvious `token` field must fail the schema rather than write an operator
		// bearer into config.json, where nothing would ever redact it again.
		const result = EdgeConfigSchema.safeParse({
			repositories: [baseRepository],
			operatorConnections: {
				prod: {
					url: "https://router.example.com",
					auth: { kind: "local", tokenEnv: "TOKEN", token: "op_secret" },
				},
			},
		});

		expect(result.success).toBe(false);
	});

	it("rejects an unknown auth kind and an empty token env name", () => {
		expect(
			EdgeConfigSchema.safeParse({
				repositories: [baseRepository],
				operatorConnections: {
					prod: { url: "https://r.example", auth: { kind: "oauth" } },
				},
			}).success,
		).toBe(false);
		expect(
			EdgeConfigSchema.safeParse({
				repositories: [baseRepository],
				operatorConnections: {
					prod: {
						url: "https://r.example",
						auth: { kind: "local", tokenEnv: "" },
					},
				},
			}).success,
		).toBe(false);
	});
});
