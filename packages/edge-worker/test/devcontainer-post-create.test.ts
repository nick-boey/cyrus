import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitService } from "../src/GitService.js";

/**
 * NOR-309: `postCreateCommand` is the only devcontainer lifecycle command
 * Cyrus honours, and it runs in the CLONE at boot rather than at image build
 * time — the source is never baked into the image.
 *
 * The method is private, so these drive it the way the boot path does: through
 * a real temp directory, asserting on what the command actually did.
 */
describe("devcontainer postCreateCommand", () => {
	let dir: string;
	let service: GitService;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "cyrus-devc-pcc-"));
		service = new GitService({} as never);
		// The boot path only honours `postCreateCommand` inside a sandbox worker,
		// which `CYRUS_REPOS_JSON` is the marker for. Stand in for it.
		process.env.CYRUS_REPOS_JSON = "[]";
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
		delete process.env.CYRUS_REPOS_JSON;
	});

	const run = () => (service as any).runDevcontainerPostCreate(dir);

	it("does nothing when the repository has no devcontainer", async () => {
		await expect(run()).resolves.toBeUndefined();
	});

	it("does not run on a physical device, which never opted into devcontainers", async () => {
		delete process.env.CYRUS_REPOS_JSON;
		mkdirSync(join(dir, ".devcontainer"), { recursive: true });
		writeFileSync(
			join(dir, ".devcontainer/devcontainer.json"),
			'{"image":"node:22","postCreateCommand":"touch ran-on-device"}',
		);
		await run();
		expect(existsSync(join(dir, "ran-on-device"))).toBe(false);
	});

	it("runs a string command through a shell, so `&&` works", async () => {
		mkdirSync(join(dir, ".devcontainer"));
		writeFileSync(
			join(dir, ".devcontainer/devcontainer.json"),
			'{"image":"node:22","postCreateCommand":"touch a && touch b"}',
		);
		await run();
		expect(existsSync(join(dir, "a"))).toBe(true);
		expect(existsSync(join(dir, "b"))).toBe(true);
	});

	it("runs an array command as argv, without a shell", async () => {
		writeFileSync(
			join(dir, ".devcontainer.json"),
			'{"image":"node:22","postCreateCommand":["touch","made-by-argv"]}',
		);
		await run();
		expect(existsSync(join(dir, "made-by-argv"))).toBe(true);
	});

	it("runs every entry of the object form", async () => {
		mkdirSync(join(dir, ".devcontainer"));
		writeFileSync(
			join(dir, ".devcontainer/devcontainer.json"),
			`{
				// comments and trailing commas are legal here
				"image": "node:22",
				"postCreateCommand": { "one": "touch one", "two": "touch two", },
			}`,
		);
		await run();
		expect(existsSync(join(dir, "one"))).toBe(true);
		expect(existsSync(join(dir, "two"))).toBe(true);
	});

	it("does not fail the boot when the command fails", async () => {
		// A repository whose post-create step fails is still worth working in;
		// a hard failure here would strand the issue with no session at all.
		writeFileSync(
			join(dir, ".devcontainer.json"),
			'{"image":"node:22","postCreateCommand":"exit 3"}',
		);
		await expect(run()).resolves.toBeUndefined();
	});

	it("does not fail the boot when the devcontainer cannot be parsed", async () => {
		writeFileSync(join(dir, ".devcontainer.json"), "{not json");
		await expect(run()).resolves.toBeUndefined();
	});

	it("prefers .devcontainer/devcontainer.json over the root file", async () => {
		mkdirSync(join(dir, ".devcontainer"));
		writeFileSync(
			join(dir, ".devcontainer/devcontainer.json"),
			'{"image":"node:22","postCreateCommand":"touch preferred"}',
		);
		writeFileSync(
			join(dir, ".devcontainer.json"),
			'{"image":"node:22","postCreateCommand":"touch ignored"}',
		);
		await run();
		expect(existsSync(join(dir, "preferred"))).toBe(true);
		expect(existsSync(join(dir, "ignored"))).toBe(false);
	});
});
