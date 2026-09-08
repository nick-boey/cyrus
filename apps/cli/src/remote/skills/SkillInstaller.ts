import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
	dirname,
	isAbsolute,
	join,
	normalize,
	relative,
	resolve,
	sep,
} from "node:path";
import { gunzipSync } from "node:zlib";
import { TransientError, UsageError } from "../errors.js";
import type { TrustedSkillRelease } from "./TrustedSkillRegistry.js";

export type SupportedAgent = "claude" | "codex";
export const SUPPORTED_AGENTS: readonly SupportedAgent[] = ["claude", "codex"];
const MAX_ARCHIVE_BYTES = 16 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 32 * 1024 * 1024;
const MAX_CHECKSUM_BYTES = 4 * 1024;

export interface SkillInstallerOptions {
	fetchFn?: typeof fetch;
	homeDir?: string;
	beforeCommit?: () => void;
	/** Test seam immediately before the atomic pointer publication. */
	beforePublish?: () => void;
}

export class SkillInstaller {
	private readonly fetchFn: typeof fetch;
	constructor(private readonly options: SkillInstallerOptions = {}) {
		this.fetchFn = options.fetchFn ?? fetch;
	}

	async install(
		release: TrustedSkillRelease,
		target: SupportedAgent,
	): Promise<string> {
		if (!SUPPORTED_AGENTS.includes(target))
			throw new UsageError(
				`Unsupported agent "${target}". Supported agents: ${SUPPORTED_AGENTS.join(", ")}.`,
			);
		const configuredHome = this.options.homeDir ?? process.env.HOME;
		if (!configuredHome?.trim())
			throw new UsageError(
				"Cannot determine the home directory for skill installation.",
			);
		const home = resolve(configuredHome);
		const root = join(
			home,
			target === "claude" ? ".claude" : ".codex",
			"skills",
		);
		const destination = join(root, release.name);
		const checksumResponse = await this.download(
			release.checksumUrl,
			MAX_CHECKSUM_BYTES,
		);
		const publishedChecksum = parseChecksum(
			new TextDecoder().decode(checksumResponse),
		);
		if (publishedChecksum !== release.expectedChecksum)
			throw new UsageError(
				"The router-advertised checksum does not match the official Cyrus release checksum.",
			);
		const archive = await this.download(release.archiveUrl, MAX_ARCHIVE_BYTES);
		const actual = `sha256:${createHash("sha256").update(archive).digest("hex")}`;
		if (actual !== release.expectedChecksum)
			throw new UsageError(
				`Skill checksum mismatch: expected ${release.expectedChecksum}, received ${actual}.`,
			);

		const stagingRoot = mkdtempSync(join(tmpdir(), "cyrus-skill-install-"));
		try {
			const staged = join(stagingRoot, release.name);
			mkdirSync(staged, { recursive: true, mode: 0o700 });
			extractTarGz(archive, staged, release.name);
			if (!existsSync(join(staged, "SKILL.md")))
				throw new UsageError(
					"Skill archive is truncated or does not contain SKILL.md.",
				);
			this.options.beforeCommit?.();
			mkdirSync(root, { recursive: true });
			if (existsSync(destination) && !lstatSync(destination).isSymbolicLink())
				throw new UsageError(
					`Refusing to replace unmanaged skill directory ${destination}. Move it aside and retry.`,
				);
			const managedRoot = join(root, ".cyrus-trusted", release.name);
			mkdirSync(managedRoot, { recursive: true });
			const installed = join(
				managedRoot,
				`${release.version}-${release.expectedChecksum.slice("sha256:".length)}`,
			);
			const incoming = `${installed}.incoming-${process.pid}-${randomUUID()}`;
			cpSync(staged, incoming, {
				recursive: true,
				errorOnExist: true,
				force: false,
			});
			let createdInstalled = false;
			try {
				if (existsSync(installed)) {
					if (hashTree(installed) !== hashTree(incoming))
						throw new UsageError(
							`The managed copy of ${release.name} ${release.version} was modified; remove ${installed} and retry.`,
						);
					rmSync(incoming, { recursive: true, force: true });
				} else {
					renameSync(incoming, installed);
					createdInstalled = true;
				}
				const pointer = `${destination}.incoming-${process.pid}`;
				rmSync(pointer, { force: true });
				const pointerTarget =
					process.platform === "win32"
						? installed
						: relative(dirname(destination), installed);
				symlinkSync(
					pointerTarget,
					pointer,
					process.platform === "win32" ? "junction" : "dir",
				);
				this.options.beforePublish?.();
				// Renaming a symlink over an absent path or another symlink is one
				// filesystem operation: readers see the complete old or new tree.
				renameSync(pointer, destination);
			} catch (error) {
				rmSync(incoming, { recursive: true, force: true });
				if (createdInstalled)
					rmSync(installed, { recursive: true, force: true });
				rmSync(`${destination}.incoming-${process.pid}`, { force: true });
				throw error;
			}
			return destination;
		} finally {
			rmSync(stagingRoot, { recursive: true, force: true });
		}
	}

	private async download(url: string, maxBytes: number): Promise<Uint8Array> {
		const expected = new URL(url);
		let acceptedUrl = url;
		if (expected.origin !== "https://github.com")
			throw new UsageError(
				"Trusted skill downloads must use the official Cyrus release origin.",
			);
		let response: Response;
		try {
			response = await this.fetchFn(url, { redirect: "manual" });
		} catch (error) {
			throw new TransientError(
				`Could not download the trusted skill release: ${(error as Error).message}`,
				{ cause: error },
			);
		}
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			let redirected: URL;
			try {
				redirected = new URL(location ?? "", url);
			} catch {
				throw new UsageError(
					"The trusted skill download returned an invalid redirect.",
				);
			}
			if (
				redirected.protocol !== "https:" ||
				redirected.hostname !== "release-assets.githubusercontent.com"
			) {
				throw new UsageError(
					"The trusted skill download redirected outside GitHub's release-asset service.",
				);
			}
			response = await this.fetchFn(redirected, { redirect: "manual" });
			acceptedUrl = redirected.href;
			if (response.status >= 300 && response.status < 400)
				throw new UsageError(
					"The trusted skill release asset redirected more than once.",
				);
		}
		if (!response.ok)
			throw new TransientError(
				`Trusted skill download failed with HTTP ${response.status}.`,
			);
		if (response.url && response.url !== acceptedUrl)
			throw new UsageError(
				"The trusted skill response came from an unexpected URL.",
			);
		const declaredLength = Number(response.headers.get("content-length"));
		if (Number.isFinite(declaredLength) && declaredLength > maxBytes)
			throw new UsageError(
				"The trusted skill release asset exceeds its size limit.",
			);
		const body = new Uint8Array(await response.arrayBuffer());
		if (body.byteLength > maxBytes)
			throw new UsageError(
				"The trusted skill release asset exceeds its size limit.",
			);
		return body;
	}
}

function hashTree(directory: string): string {
	const hash = createHash("sha256");
	const visit = (current: string, prefix: string): void => {
		for (const entry of readdirSync(current, { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name),
		)) {
			const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isSymbolicLink())
				throw new UsageError(
					`Managed skill contains an unexpected link: ${relativePath}`,
				);
			if (entry.isDirectory()) visit(join(current, entry.name), relativePath);
			else if (entry.isFile()) {
				hash.update(relativePath);
				hash.update("\0");
				hash.update(readFileSync(join(current, entry.name)));
				hash.update("\0");
			} else
				throw new UsageError(
					`Managed skill contains an unsupported entry: ${relativePath}`,
				);
		}
	};
	visit(directory, "");
	return hash.digest("hex");
}

function parseChecksum(bytes: string): string {
	const match = bytes.trim().match(/^([0-9a-f]{64})(?:\s+\*?[^\s]+)?$/);
	if (!match)
		throw new UsageError("The official skill checksum file is malformed.");
	return `sha256:${match[1]}`;
}

function extractTarGz(
	archive: Uint8Array,
	destination: string,
	skillName: string,
): void {
	let tar: Buffer;
	try {
		tar = gunzipSync(archive, { maxOutputLength: MAX_EXTRACTED_BYTES });
	} catch (error) {
		throw new UsageError("Skill archive is truncated or not valid gzip data.", {
			cause: error,
		});
	}
	let offset = 0;
	while (offset + 512 <= tar.length) {
		const header = tar.subarray(offset, offset + 512);
		if (header.every((byte) => byte === 0)) return;
		const name = readField(header, 0, 100);
		const prefix = readField(header, 345, 155);
		const path = prefix ? `${prefix}/${name}` : name;
		const sizeText = readField(header, 124, 12).trim();
		const size = sizeText ? Number.parseInt(sizeText, 8) : 0;
		if (!Number.isSafeInteger(size) || size < 0)
			throw new UsageError("Skill archive contains an invalid entry size.");
		const type = String.fromCharCode(header[156] ?? 0);
		const normalized = normalize(path).replaceAll("\\", "/");
		const prefixPath = `${skillName}/`;
		if (
			isAbsolute(path) ||
			normalized === ".." ||
			normalized.startsWith("../") ||
			(!normalized.startsWith(prefixPath) && normalized !== skillName)
		)
			throw new UsageError(`Skill archive contains an unsafe path: ${path}`);
		const relativePath =
			normalized === skillName ? "" : normalized.slice(prefixPath.length);
		const target = resolve(destination, relativePath);
		const rel = relative(destination, target);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
			throw new UsageError(`Skill archive entry escapes the target: ${path}`);
		if (type === "1" || type === "2")
			throw new UsageError(
				`Skill archive contains a link, which is not permitted: ${path}`,
			);
		if (type === "5") mkdirSync(target, { recursive: true, mode: 0o755 });
		else if (type === "0" || type === "\0") {
			if (offset + 512 + size > tar.length)
				throw new UsageError("Skill archive is truncated.");
			mkdirSync(dirname(target), { recursive: true });
			writeFileSync(target, tar.subarray(offset + 512, offset + 512 + size), {
				mode: 0o644,
			});
			chmodSync(target, 0o644);
		} else
			throw new UsageError(
				`Skill archive contains unsupported entry type ${JSON.stringify(type)}.`,
			);
		offset += 512 + Math.ceil(size / 512) * 512;
	}
	throw new UsageError("Skill archive is truncated.");
}

function readField(header: Buffer, start: number, length: number): string {
	return header
		.subarray(start, start + length)
		.toString("utf8")
		.replace(/\0.*$/, "");
}
