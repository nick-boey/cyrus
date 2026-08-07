/**
 * First sign-in bootstrap for the `/setup*` management UI, plus the shared
 * resolution of which executor a user's sessions route to.
 *
 * Two records have to exist before a teammate is usable, and it is easy to
 * think of only one:
 *
 * 1. The SQLite `users` row. Without it there is no `user_id`, so `EventRouter`
 *    cannot route the teammate's issues and `ContainerTargetService` has no
 *    owner to boot a container for.
 * 2. The secret record — the env-var bundle, with every required key present
 *    (empty when unset) so the setup page has rows to render and the boot gate
 *    has something to report `missing` against.
 *
 * {@link SetupBootstrap.ensure} does both, idempotently. Running it on every
 * `/setup` request rather than only the first is what makes it self-healing:
 * adding an entry to `containers.requiredSecretKeys` backfills into existing
 * users' records the next time they open the page, instead of leaving them with
 * a record that silently lacks a key the boot gate now demands.
 */

import type { RouterStore } from "../RouterStore.js";
import { normalizeSecretKey, type SecretStoreBackend } from "../SecretStore.js";
import { SetupConflictError, TableSecretStore } from "../TableSecretStore.js";
import { SetupAuthError, type SetupPrincipal } from "./principal.js";

/** `users.executor_json` type meaning "pin this user to their own machine". */
export const EXECUTOR_TYPE_DEVICE = "device";

/**
 * `users.executor_json` type meaning "inherit `containers.defaultExecutor`".
 *
 * This sentinel exists because NULL cannot carry that meaning. `cyrus router
 * users set-executor <email> device` has always written NULL, so a NULL row is
 * already ambiguous between "explicitly set to device" and "never configured",
 * and no column added later can retrospectively recover which one it was. NULL
 * therefore keeps its historical meaning — physical device — and only this
 * explicit opt-in picks up the router-wide default. See F11 on NOR-265.
 */
export const EXECUTOR_TYPE_DEFAULT = "default";

/** The literal stored for a user who inherits `containers.defaultExecutor`. */
export const INHERIT_DEFAULT_EXECUTOR_JSON = JSON.stringify({
	type: EXECUTOR_TYPE_DEFAULT,
});

/**
 * Which container provider a user's sessions route to, or `undefined` for the
 * physical-device path.
 *
 * | Stored `executor_json`  | Meaning                          | Inherits default |
 * | ----------------------- | -------------------------------- | ---------------- |
 * | `NULL` / absent         | physical device (historical)     | no               |
 * | `{"type":"device"}`     | physical device, explicit        | no               |
 * | `{"type":"default"}`    | inherit `defaultExecutor`        | **yes**          |
 * | `{"type":"aca"}` etc    | that executor                    | no               |
 * | corrupt / unparseable   | physical device, with a warning  | no               |
 *
 * The one-way direction of every degradation is deliberate: an unreadable or
 * malformed setting is an *unknown* intent, not an unset one, and quietly
 * upgrading it to "boot a cloud sandbox" is the wrong way to fail. Physical
 * device is the safe landing spot in every ambiguous case.
 */
export function resolveExecutor(
	executorJson: string | null | undefined,
	defaultExecutor: string | undefined,
	logger?: { warn(msg: string): void },
): string | undefined {
	if (
		executorJson === null ||
		executorJson === undefined ||
		executorJson.trim() === ""
	) {
		return undefined;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(executorJson);
	} catch {
		logger?.warn(
			`Corrupt executor_json ${JSON.stringify(executorJson)}; using physical device`,
		);
		return undefined;
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		logger?.warn(
			`executor_json ${JSON.stringify(executorJson)} is not a JSON object; using physical device`,
		);
		return undefined;
	}

	const rawType = (parsed as { type?: unknown }).type;
	if (typeof rawType !== "string" || rawType.trim() === "") {
		logger?.warn(
			`executor_json ${JSON.stringify(executorJson)} has no usable "type"; using physical device`,
		);
		return undefined;
	}

	const type = rawType.trim();
	if (type === EXECUTOR_TYPE_DEVICE) return undefined;
	if (type !== EXECUTOR_TYPE_DEFAULT) return type;

	const fallback = defaultExecutor?.trim();
	if (!fallback) return undefined;
	if (fallback === EXECUTOR_TYPE_DEVICE || fallback === EXECUTOR_TYPE_DEFAULT) {
		// A default of "device"/"default" is a configuration mistake: neither is
		// a container provider name, and returning one would make
		// `executors.get(...)` fail on every routed event instead of here, once.
		logger?.warn(
			`containers.defaultExecutor is ${JSON.stringify(defaultExecutor)}, which is not a container provider name; using physical device`,
		);
		return undefined;
	}
	return fallback;
}

/** The form `users.email` is compared on: `UNIQUE COLLATE NOCASE`. */
function normalizeEmail(email: string | undefined): string {
	return String(email ?? "")
		.trim()
		.toLowerCase();
}

/** One wording for "no such user", so authorize and ensure cannot diverge. */
function unregisteredMessage(email: string): string {
	return `${email} is not a registered Cyrus user. Ask an administrator to run: cyrus router users add ${email}`;
}

export interface SetupBootstrapLogger {
	info(msg: string): void;
	warn(msg: string): void;
}

export interface SetupBootstrapDeps {
	store: RouterStore;
	secrets: SecretStoreBackend;
	/**
	 * `DEFAULT_REQUIRED_SECRET_KEYS` ∪ `containers.requiredSecretKeys`, computed
	 * once by `RouterServer` and shared with `ContainerTargetService` so the page
	 * and the container boot gate can never disagree about what "required"
	 * means — which is the failure mode where the UI says "all set" and the
	 * container refuses to boot.
	 */
	requiredKeys: readonly string[];
	/**
	 * Whether an email with no `users` row may register itself.
	 *
	 * Defaults to **false** at the config layer (F5 on NOR-265): getting past
	 * the auth sidecar and `setupUi.allowedDomain` is only a real gate once the
	 * app registration actually enforces assignment, which is a separate,
	 * verifiable operator step. Turning this on without it lets any tenant user
	 * provision themselves.
	 */
	autoProvisionUsers: boolean;
	logger: SetupBootstrapLogger;
}

export interface SetupBootstrapResult {
	userId: number;
	createdUser: boolean;
	createdRecord: boolean;
}

/**
 * Backends that can create/extend a whole record in one conditional write.
 * Only {@link TableSecretStore} has this today; the file and Key Vault backends
 * are per-key stores, so local development has to keep working without it.
 */
interface RecordCapableBackend extends SecretStoreBackend {
	ensureRecord(
		email: string,
		requiredKeys: readonly string[],
	): Promise<{ created: boolean }>;
}

/**
 * Store methods this change and NOR-274 add to {@link RouterStore}. They are
 * declared optional and feature-detected so `SetupBootstrap` composes with a
 * store that predates them rather than crashing on a missing method.
 */
interface OptionalStoreMethods {
	getUserByEmail?(
		email: string,
	): { userId: number; email: string; name?: string } | undefined;
	getUserEntraObjectId?(userId: number): string | undefined;
	setUserEntraObjectId?(userId: number, objectId: string): boolean;
}

/**
 * A record API must be **declared**, not merely present. `supportsRecords()` is
 * the seam `TableSecretStore` exposes for exactly this, so a backend that grows
 * an incompatible `ensureRecord` later cannot be silently routed onto the
 * atomic path by a bare `typeof … === "function"` check.
 */
function supportsRecordApi(
	backend: SecretStoreBackend,
): backend is RecordCapableBackend {
	const candidate = backend as Partial<RecordCapableBackend> & {
		supportsRecords?: () => boolean;
	};
	if (typeof candidate.ensureRecord !== "function") return false;
	if (typeof candidate.supportsRecords === "function") {
		return candidate.supportsRecords() === true;
	}
	return backend instanceof TableSecretStore;
}

/**
 * Makes a signed-in teammate's router state exist. Never creates a device row,
 * an enrollment code, or a container.
 */
export class SetupBootstrap {
	private readonly store: RouterStore & OptionalStoreMethods;

	constructor(private readonly deps: SetupBootstrapDeps) {
		this.store = deps.store;
	}

	/**
	 * Resolves the RouterStore user a signed-in principal maps to, and refuses
	 * the request when there is not one. **Creates nothing, ever.**
	 *
	 * This is the authorization half of {@link ensure}, split out because the two
	 * answer different questions and only one of them is a state change:
	 *
	 * - `ensure` asks *"may this principal become a user?"* — the question
	 *   `POST /setup/provision` exists to ask, governed by `autoProvisionUsers`.
	 * - `authorize` asks *"is this principal already a user?"* — what every
	 *   other mutating route needs to know **before it touches the secret
	 *   store**, and which no auto-provisioning setting may answer "yes" to.
	 *
	 * Collapsing the two is the R2-02 defect: routes that called neither let any
	 * tenant principal the auth sidecar admits create an encrypted secret record
	 * for an unregistered address, pre-seeding values that would attach to the
	 * real account the moment an administrator registered that email.
	 */
	authorize(principal: SetupPrincipal): { userId: number; email: string } {
		const email = normalizeEmail(principal.email);
		if (!email) {
			throw new SetupAuthError(401, "signed-in identity carries no email");
		}
		const existing = this.findUser(email);
		if (!existing) {
			throw new SetupAuthError(403, unregisteredMessage(email), "unregistered");
		}
		return { userId: existing.userId, email };
	}

	/**
	 * Non-throwing form of {@link authorize}, for choosing which page to render.
	 *
	 * This is the only correct source of "is this teammate provisioned?".
	 * Inferring it from a non-empty secret bundle — as `/setup` originally did —
	 * treats a record the principal created themselves as proof of registration.
	 */
	isRegistered(principal: SetupPrincipal): boolean {
		const email = normalizeEmail(principal.email);
		return email !== "" && this.findUser(email) !== undefined;
	}

	async ensure(principal: SetupPrincipal): Promise<SetupBootstrapResult> {
		const email = normalizeEmail(principal.email);
		if (!email) {
			// `requireSetupPrincipal` already rejects this; re-checking here keeps
			// the invariant local, because an empty email would otherwise become a
			// `users` row nobody can ever sign in as.
			throw new SetupAuthError(401, "signed-in identity carries no email");
		}
		const { userId, createdUser } = this.ensureUser(email, principal.name);
		this.recordObjectId(userId, email, principal.objectId);
		const createdRecord = await this.ensureRecord(email);
		return { userId, createdUser, createdRecord };
	}

	private findUser(
		email: string,
	): { userId: number; email: string } | undefined {
		if (typeof this.store.getUserByEmail === "function") {
			return this.store.getUserByEmail(email);
		}
		// `RouterStore` has no by-email lookup yet. `users.email` is `UNIQUE
		// COLLATE NOCASE`, so the comparison here must be case-insensitive too:
		// a case-varying sign-in has to resolve to the same row rather than
		// attempting an insert that the constraint rejects.
		return this.deps.store
			.listUsers()
			.find((user) => user.email.toLowerCase() === email);
	}

	private ensureUser(
		email: string,
		name: string | undefined,
	): { userId: number; createdUser: boolean } {
		const existing = this.findUser(email);
		if (existing) return { userId: existing.userId, createdUser: false };

		if (!this.deps.autoProvisionUsers) {
			// Deliberately NOT tagged "unregistered": this is the one refusal that
			// `/setup` cannot resolve. Auto-provisioning is off, so bouncing the
			// caller back there would hand them a provisioning button that is
			// guaranteed to fail, instead of the administrator's command.
			throw new SetupAuthError(403, unregisteredMessage(email));
		}

		let userId: number;
		try {
			({ userId } = this.deps.store.addUser({
				email,
				...(name ? { name } : {}),
			}));
		} catch (error) {
			// Two tabs signing in at once both saw "no user" and both inserted.
			// `users.email` is UNIQUE COLLATE NOCASE, so the loser lands here —
			// re-read rather than surfacing a SQLITE_CONSTRAINT to a teammate whose
			// only mistake was double-clicking.
			const raced = this.findUser(email);
			if (raced) return { userId: raced.userId, createdUser: false };
			throw error;
		}

		// Written explicitly, and only for users created here. Leaving it NULL
		// would pin every new teammate to a physical device they have not
		// enrolled; writing it onto *existing* NULL rows would do the opposite
		// and move deliberately-device users onto cloud sandboxes.
		this.deps.store.setUserExecutor(email, INHERIT_DEFAULT_EXECUTOR_JSON);
		this.deps.logger.info(
			`Provisioned Cyrus user ${email} from /setup (executor: router default)`,
		);
		return { userId, createdUser: true };
	}

	/**
	 * Persists the Entra `oid` on the user row — the interim mitigation for
	 * NOR-274, which re-keys identity from email to `(tenantId, oid)`. Storing
	 * it now (cheap, additive) is what gives that migration the data it needs.
	 *
	 * A known email presenting a *different* `oid` is **refused with a 403**.
	 *
	 * This was previously a warning. It should not have been: a UPN rename
	 * changes the *email* and keeps the `oid`, so it produces a NEW user row,
	 * not a mismatch. The only thing that produces a mismatch is the same
	 * address now resolving to a different Entra object — an address reused for
	 * a different person, which is precisely the case where letting the sign-in
	 * proceed would hand them the previous holder's stored secrets (R2-07).
	 *
	 * An account deleted and recreated for the same human also lands here. That
	 * is indistinguishable from reuse without out-of-band knowledge, so it is
	 * resolved the same way: an operator rebinds the row deliberately. Failing
	 * closed costs that person one support request; failing open costs the
	 * previous holder every credential they ever stored.
	 *
	 * The stored value is never overwritten, so the block persists until an
	 * operator acts rather than curing itself on the next sign-in.
	 */
	private recordObjectId(
		userId: number,
		email: string,
		objectId: string | undefined,
	): void {
		if (!objectId) return;
		const read = this.store.getUserEntraObjectId;
		const write = this.store.setUserEntraObjectId;
		if (typeof read !== "function" || typeof write !== "function") return;

		const stored = read.call(this.store, userId);
		if (!stored) {
			write.call(this.store, userId, objectId);
			return;
		}
		if (stored === objectId) return;
		this.deps.logger.warn(
			`Refusing setup access for ${email}: its Entra object id changed from ` +
				`${stored} to ${objectId}. The same address now belongs to a ` +
				"different Entra object, so honouring this sign-in would hand the " +
				"previous holder's stored secrets to a new principal. An operator " +
				"must confirm the account and rebind the row deliberately. Tracked " +
				"by NOR-274, which re-keys identity from email to (tenant, oid).",
		);
		throw new SetupAuthError(
			403,
			"This account is not recognised. Your directory identity has changed since it was registered — contact an administrator to re-link it.",
		);
	}

	/**
	 * Adds every required key that is absent, as an empty string, and never
	 * overwrites a stored value.
	 */
	private async ensureRecord(email: string): Promise<boolean> {
		// Normalize (legacy name -> env-var name, reserved/invalid rejected)
		// before any network call, exactly like the backends do, so a bad
		// `requiredSecretKeys` entry fails loudly instead of writing a key the
		// bundle will never expose under that name.
		const requiredKeys = this.deps.requiredKeys.map((key) =>
			normalizeSecretKey(key),
		);

		const backend = this.deps.secrets;
		if (supportsRecordApi(backend)) {
			try {
				const { created } = await backend.ensureRecord(email, requiredKeys);
				return created;
			} catch (error) {
				if (!(error instanceof SetupConflictError)) throw error;
				return await this.acceptConcurrentRecord(email, requiredKeys, error);
			}
		}

		// File / Key Vault backends: per-key fallback. Read once, then write only
		// the genuinely absent keys — `set()` is a whole-file rewrite on the file
		// backend, so writing unconditionally would be O(n) rewrites per page load.
		const bundle = await backend.get(email);
		let created = false;
		for (const key of requiredKeys) {
			if (Object.hasOwn(bundle, key)) continue;
			await backend.set(email, key, "");
			created = true;
		}
		return created;
	}

	/**
	 * Two simultaneous first sign-ins are a race, not a failure: the loser's
	 * conditional write is rejected precisely because the winner already wrote
	 * the record it was going to write. Report success — but only after
	 * confirming the surviving record genuinely satisfies `requiredKeys`, so a
	 * contended save that lost for some other reason still surfaces as an error
	 * rather than as a page that claims to be set up and is not.
	 */
	private async acceptConcurrentRecord(
		email: string,
		requiredKeys: readonly string[],
		conflict: SetupConflictError,
	): Promise<boolean> {
		const bundle = await this.deps.secrets.get(email);
		const missing = requiredKeys.filter((key) => !Object.hasOwn(bundle, key));
		if (missing.length > 0) throw conflict;
		this.deps.logger.warn(
			`Setup record for ${email} was created concurrently by another sign-in; using it (${conflict.message})`,
		);
		return false;
	}
}
