import {
	createCipheriv,
	createDecipheriv,
	createHash,
	randomBytes,
} from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import type { KeyWrapper } from "./envelope.js";

const KEK_BYTES = 32;
const IV_BYTES = 12;
const AUTH_TAG_BYTES = 16;

/**
 * A {@link KeyWrapper} backed by a 0600 key file on local disk, for
 * deployments with no Azure Key Vault.
 *
 * This exists so `sealBundle`/`openBundle` can be used unconditionally rather
 * than being skipped on non-Azure routers. Skipping was the alternative and it
 * is worse: the thing being sealed is a Codex subscription credential, and
 * `users` is plain SQLite that `StateBackup.upload` PUTs wholesale to blob
 * storage — a "no Key Vault, so store it in the clear" branch would put a live
 * OAuth refresh token into every backup.
 *
 * **What it does and does not buy.** The key sits on the same host as the
 * database, so this is not the key-separation a Key Vault KEK provides; anyone
 * who can read the router's data directory can read both. What it does provide
 * is that the credential is absent from the `.db` file itself, and therefore
 * from every artefact derived from it — the backup blob, a copied database, a
 * support bundle. That is the boundary that actually gets crossed in practice.
 * A deployment holding real subscription credentials should still configure
 * `containers.tableStore.keyId`.
 *
 * The envelope format is unchanged, so a record written here is
 * indistinguishable in shape from a Key Vault one. `version` is a digest of the
 * key rather than a random id, which makes {@link unwrap} able to say "this
 * record was sealed with a different key" instead of failing as generic
 * corruption when a key file is replaced.
 */
export class LocalKeyWrapper implements KeyWrapper {
	private readonly kek: Buffer;
	private readonly kekVersion: string;

	constructor(keyPath: string) {
		this.kek = LocalKeyWrapper.loadOrCreateKey(keyPath);
		// `assertKekVersion` demands exactly 32 lowercase hex characters, so the
		// digest is truncated to that width. It identifies the key; it is not a
		// secret and is stored alongside the ciphertext either way.
		this.kekVersion = createHash("sha256")
			.update(this.kek)
			.digest("hex")
			.slice(0, 32);
	}

	get version(): string {
		return this.kekVersion;
	}

	async wrap(dek: Buffer): Promise<{ version: string; wrapped: Buffer }> {
		const iv = randomBytes(IV_BYTES);
		const cipher = createCipheriv("aes-256-gcm", this.kek, iv);
		const wrapped = Buffer.concat([cipher.update(dek), cipher.final()]);
		return {
			version: this.kekVersion,
			// iv || ciphertext || tag, so `unwrap` needs no side channel.
			wrapped: Buffer.concat([iv, wrapped, cipher.getAuthTag()]),
		};
	}

	async unwrap(version: string, wrapped: Buffer): Promise<Buffer> {
		if (version !== this.kekVersion) {
			throw new Error(
				"This record was sealed with a different local key. The key file beside the router database has been replaced or restored from elsewhere; the stored Codex credential cannot be recovered and must be pasted again.",
			);
		}
		if (wrapped.length <= IV_BYTES + AUTH_TAG_BYTES) {
			throw new Error("Sealed local key material is truncated");
		}
		const iv = wrapped.subarray(0, IV_BYTES);
		const tag = wrapped.subarray(wrapped.length - AUTH_TAG_BYTES);
		const body = wrapped.subarray(IV_BYTES, wrapped.length - AUTH_TAG_BYTES);
		const decipher = createDecipheriv("aes-256-gcm", this.kek, iv);
		decipher.setAuthTag(tag);
		return Buffer.concat([decipher.update(body), decipher.final()]);
	}

	private static loadOrCreateKey(keyPath: string): Buffer {
		if (existsSync(keyPath)) {
			const raw = readFileSync(keyPath);
			// Stored as hex so the file survives a text-mode copy intact.
			const key = Buffer.from(raw.toString("utf-8").trim(), "hex");
			if (key.length !== KEK_BYTES) {
				throw new Error(
					`${keyPath} is not a ${KEK_BYTES}-byte hex key. Delete it to have a new one generated — any stored Codex credential will have to be pasted again.`,
				);
			}
			// Re-assert perms on every open: a restore or a `docker cp` can widen
			// them, and the file is the only thing protecting the credential.
			chmodSync(keyPath, 0o600);
			return key;
		}
		const key = randomBytes(KEK_BYTES);
		mkdirSync(dirname(keyPath), { recursive: true });
		const tmp = `${keyPath}.tmp`;
		writeFileSync(tmp, `${key.toString("hex")}\n`, { mode: 0o600 });
		chmodSync(tmp, 0o600);
		renameSync(tmp, keyPath);
		return key;
	}
}
