/**
 * Hand-rolled REST client for the Azure Container Apps (ACA) Sandboxes
 * data plane.
 *
 * Why hand-rolled: the only SDK available for the preview data plane is
 * `@azure/containerapps-sandbox` (beta), whose TS model field names
 * silently diverge from the wire (see spike finding C5 — `autoSuspend`
 * vs `autoSuspendPolicy`). A thin typed wrapper around `fetch` keeps us
 * honest against the wire shapes confirmed in `docs/superpowers/specs/
 * 2026-07-25-aca-sandboxes-spike-findings.md` (S2).
 *
 * Scope: this file talks to ONE sandbox group in ONE region. The router
 * provider (Task 5) layers issue↔sandbox mapping on top via labels.
 */

import {
	cyrusSpanAttributes,
	getTracer,
	type Span,
	SpanKind,
	withSpan,
} from "cyrus-otel-traces";

/** Instrumentation scope for ACA data-plane dependency spans. */
const ACA_TRACER_NAME = "cyrus-aca-client";

export type AcaSandboxState =
	| "Running"
	| "Stopped"
	| "Suspended"
	| "Idle"
	| "Resuming"
	| "Stopping"
	| "Creating"
	| "Deleting"
	| string;

export interface AcaSandbox {
	id: string;
	state: AcaSandboxState;
	labels?: Record<string, string>;
	outboundIpAddresses?: string;
	/** Other useful fields the wire returns; kept optional. */
	[x: string]: any;
}

export interface AcaSnapshot {
	id: string;
	labels?: Record<string, string>;
	sandboxId?: string;
	status?: string;
	/**
	 * VMM type (memory-mode suspend vs disk-only). The spike observed
	 * the implicit-suspend snapshot returning a `vmmType`.
	 */
	vmmType?: string;
	createdAtUtc?: string;
	/** Normalised resource size of the snapshot. */
	sizeInMB?: number;
	[x: string]: any;
}

export interface AcaDiskImage {
	id?: string;
	name?: string;
	labels?: Record<string, string>;
	image?: string | { base?: string };
	status?: string | { state?: string; errorMessage?: string };
	sizeInMB?: number;
	[x: string]: any;
}

export interface AcaEgressHostRule {
	pattern: string;
	action: "Allow" | "Deny";
}

export interface AcaEgressPolicy {
	defaultAction: "Allow" | "Deny";
	/** C4: wire field is `trafficInspection`, NOT `inspectionMode`. */
	trafficInspection: "Legacy" | "Full" | "Partial" | "None";
	hostRules?: AcaEgressHostRule[];
	/** Reserved for future use — accepted but not asserted in v1. */
	rules?: any[];
}

export interface AcaLifecyclePolicySubPolicy {
	enabled: boolean;
	interval: number;
	mode: "Memory" | "Disk";
}

export interface AcaLifecyclePolicy {
	/**
	 * C5: wire field name is `autoSuspendPolicy` (NOT `autoSuspend` —
	 * sending the SDK's name is silently ignored).
	 */
	autoSuspendPolicy?: AcaLifecyclePolicySubPolicy;
	autoDeletePolicy?: AcaLifecyclePolicySubPolicy;
}

export interface AcaSandboxCreateBody {
	/** Exactly one of diskImageName / diskImageId / snapshotId. */
	diskImageName?: string;
	diskImageId?: string;
	snapshotId?: string;
	/** Create-from-image only. Write-only — never returned by GET. */
	environment?: Record<string, string>;
	/** Optional CPU/memory tier strings; provider passes mapped values. */
	resources?: Record<string, string>;
	lifecycle?: AcaLifecyclePolicy;
	labels?: Record<string, string>;
	egressPolicy?: AcaEgressPolicy;
	/**
	 * Exec-form override arrays. The wire type is `IReadOnlyList<string>`, NOT
	 * a single shell string — sending a bare string is rejected with
	 * `400 "The JSON value could not be converted to
	 * System.Collections.Generic.IReadOnlyList\`1[System.String]"`.
	 *
	 * Normally leave both unset: ACA honours the disk image's own OCI
	 * ENTRYPOINT (verified live — a redis:alpine disk booted `redis-server`
	 * with no override), so the worker image's `ENTRYPOINT ["/entrypoint.sh"]`
	 * is what starts the worker. Note the entrypoint runs as a CHILD process;
	 * PID 1 is always ACA's own `tini -- sleep infinity` keep-alive, so PID 1
	 * is never evidence about whether the workload started.
	 */
	entrypoint?: string[];
	cmd?: string[];
	/** Forwarded to sourcesRef.diskImage.isPublic when booting a public image. */
	diskImageIsPublic?: boolean;
}

/**
 * Minimal error carrying the parsed ProblemDetails body.
 *
 * The data plane surfaces two ProblemDetails variants (no ARM error
 * envelope): validation `{title,status,errors,...}` and domain
 * `{title,status,detail,errorCause,...}`. We surface `title` plus
 * `errors`/`detail` in the message and keep `body` raw for callers that
 * want the full diagnostic.
 */
export class AcaApiError extends Error {
	status: number;
	body?: unknown;
	constructor(status: number, body: unknown) {
		const parts: string[] = [`HTTP ${status}`];
		if (body && typeof body === "object") {
			const b = body as Record<string, unknown>;
			if (typeof b.title === "string") parts.push(b.title);
			const errs = b.errors;
			if (errs && typeof errs === "object") {
				const flat: string[] = [];
				for (const [k, v] of Object.entries(errs as Record<string, unknown>)) {
					if (Array.isArray(v)) {
						for (const item of v) flat.push(`${k}: ${String(item)}`);
					} else {
						flat.push(`${k}: ${String(v)}`);
					}
				}
				if (flat.length > 0) parts.push(flat.join("; "));
			} else if (typeof b.detail === "string") {
				parts.push(b.detail);
			}
		} else if (typeof body === "string" && body.length > 0) {
			parts.push(body);
		}
		super(parts.join(" — "));
		this.name = "AcaApiError";
		this.status = status;
		this.body = body;
	}
}

/**
 * On first use, role assignments for the *Container Apps SandboxGroup Data
 * Owner* role may not have propagated yet (preview docs say 30–60s; the
 * spike measured <1min). The client retries 403s for ~100s before giving
 * up. A 401 (wrong token audience) is NOT retried — that's a config bug.
 */
const RBAC_403_RETRY_MAX = 20;
const RBAC_403_RETRY_DELAY_MS = 5_000;

/**
 * Per-request deadline for every ACA data-plane call.
 *
 * Node's `fetch` has no overall request timeout — only undici's 300s headers
 * timeout — so a blackholed data plane (an NSG change, an egress policy that
 * silently drops rather than rejects) leaves a request pending for minutes or
 * indefinitely. That matters far beyond this client: `ensureRunning` awaits
 * these calls while holding the provider's per-issue mutex, and
 * `ContainerTargets` in turn awaits `ensureRunning` while holding the device's
 * in-flight boot slot. A single hung request therefore blocks every later boot
 * for that issue — including the wake that a terminal teardown needs — so the
 * container is only ever reclaimed by the grace deadline.
 *
 * Bounding it here means every call settles, one way or the other. Generous
 * enough not to fire on a legitimately slow control-plane operation.
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * Deadline for the calls that move the sandbox's whole memory + disk image
 * around: snapshot, suspend, resume. These are NOT control-plane calls and the
 * default deadline is far too tight for them — measured against a live 4 vCPU /
 * 8 GiB sandbox with an 18.4 GB image on 2026-08-07, `snapshot` took 3m52s and
 * `stop` took 4m09s, both returning 200.
 *
 * Under the old shared 120s deadline every one of those calls aborted mid-flight
 * while ACA went on to complete the operation server-side, so `stop()` could
 * never suspend a large sandbox: the 60s lifecycle sweep re-failed identically
 * forever and 4 vCPU sandboxes stayed Running for hours (WAG-10 / WAG-14).
 * Scaled to the observed worst case with headroom, while still bounding a truly
 * blackholed request so the per-issue mutex is always released.
 */
const SLOW_OPERATION_TIMEOUT_MS = 900_000;

/**
 * Create is synchronous (200 with `state: "Running"`) per the spike; this
 * loop is a defensive fallback the spike never exercised. Bounded tight.
 */
const LRO_MAX_POLLS = 60;
const LRO_POLL_INTERVAL_MS = 2_000;

const TERMINAL_STATES: ReadonlySet<string> = new Set([
	"Running",
	"Stopped",
	"Suspended",
	"Idle",
	"Deleting",
]);

type FetchFn = typeof fetch;
type SleepFn = (ms: number) => Promise<void>;

export class AcaSandboxClient {
	private readonly subscriptionId: string;
	private readonly resourceGroup: string;
	private readonly sandboxGroup: string;
	private readonly region: string;
	private readonly tokenProvider: () => Promise<string>;
	private readonly apiVersion: string;
	private readonly baseUrl: string;
	private readonly fetchFn: FetchFn;
	private readonly sleepFn: SleepFn;
	private readonly requestTimeoutMs: number;

	constructor(opts: {
		subscriptionId: string;
		resourceGroup: string;
		sandboxGroup: string;
		region: string;
		/** Entra bearer token, audience {@link ACA_TOKEN_AUDIENCE}. */
		tokenProvider: () => Promise<string>;
		/** Override the pinned `2026-02-01-preview` if Azure ships a new one. */
		apiVersion?: string;
		fetchFn?: FetchFn;
		/** Override `https://management.{region}.azuredevcompute.io`. */
		baseUrl?: string;
		/** Injectable for tests; default uses `setTimeout`. */
		sleepFn?: SleepFn;
		/** Per-request deadline; default 120s. `0` disables it (tests). */
		requestTimeoutMs?: number;
	}) {
		this.subscriptionId = opts.subscriptionId;
		this.resourceGroup = opts.resourceGroup;
		this.sandboxGroup = opts.sandboxGroup;
		this.region = opts.region;
		this.tokenProvider = opts.tokenProvider;
		this.apiVersion = opts.apiVersion ?? "2026-02-01-preview";
		this.baseUrl =
			opts.baseUrl ?? `https://management.${this.region}.azuredevcompute.io`;
		this.fetchFn = opts.fetchFn ?? fetch.bind(globalThis);
		this.sleepFn =
			opts.sleepFn ??
			((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
		this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
	}

	/**
	 * Per-attempt abort signal. Applied to each attempt rather than to the whole
	 * `request()` call so the RBAC-403 retry loop still gets its full budget —
	 * the point is that no SINGLE fetch can hang, not that the retry sequence is
	 * capped. Omitted entirely when the timeout is disabled, so an injected
	 * `fetchFn` in tests never sees a signal it didn't ask for.
	 */
	private timeoutSignal(overrideMs?: number): AbortSignal | undefined {
		// `0` disables timeouts wholesale (tests), so an override must not
		// resurrect one.
		if (this.requestTimeoutMs <= 0) return undefined;
		return AbortSignal.timeout(overrideMs ?? this.requestTimeoutMs);
	}

	private get root(): string {
		return `/subscriptions/${this.subscriptionId}/resourceGroups/${this.resourceGroup}/sandboxGroups/${this.sandboxGroup}`;
	}

	/**
	 * Core request helper. Sends JSON when a body is present; always
	 * attaches `Authorization: Bearer <token>` and `?api-version=...`.
	 *
	 * `okOn404` turns a 404 into `null` (used by DELETEs and getSandbox).
	 *
	 * 403 (RBAC propagation) is retried inside this helper with the same
	 * token; 401 (wrong audience) is never retried.
	 */
	private request<T>(
		method: string,
		path: string,
		body?: unknown,
		opts?: {
			okOn404?: boolean;
			query?: Record<string, string>;
			/** Override the per-attempt deadline; see {@link SLOW_OPERATION_TIMEOUT_MS}. */
			timeoutMs?: number;
		},
	): Promise<T | null> {
		// Every ACA data-plane call gets a dependency span. This is the reason
		// Phase 5 lists dependency spans as a work item at all: Node's `fetch`
		// has NO default timeout, which is why each attempt carries an explicit
		// `requestTimeoutMs` deadline — and a call that sits on that deadline for
		// two minutes is, from every other signal we have, indistinguishable from
		// a call that was never made. The span makes the stall itself the thing
		// you can see.
		return withSpan(
			getTracer(ACA_TRACER_NAME),
			"aca.request",
			{
				kind: SpanKind.CLIENT,
				attributes: {
					"http.request.method": method,
					"server.address": new URL(this.baseUrl).host,
					...cyrusSpanAttributes({
						"aca.operation": operationTemplate(path),
						// `0` means timeouts are disabled (tests); emitted as absent
						// rather than as a literal zero, which would read in a
						// dashboard as "the deadline was zero milliseconds".
						"aca.timeout_ms":
							opts?.timeoutMs ?? (this.requestTimeoutMs || undefined),
						"aca.region": this.region,
					}),
				},
			},
			(span) => this.requestTraced<T>(span, method, path, body, opts),
		);
	}

	private async requestTraced<T>(
		span: Span,
		method: string,
		path: string,
		body?: unknown,
		opts?: {
			okOn404?: boolean;
			query?: Record<string, string>;
			timeoutMs?: number;
		},
	): Promise<T | null> {
		const token = await this.tokenProvider();
		const url = this.buildUrl(path, opts?.query);
		const init: RequestInit = {
			method,
			headers: { authorization: `Bearer ${token}` },
		};
		if (body !== undefined) {
			init.body = JSON.stringify(body);
			(init.headers as Record<string, string>)["content-type"] =
				"application/json";
		}

		let lastStatus = 0;
		let lastBody: any;
		for (let attempt = 0; attempt <= RBAC_403_RETRY_MAX; attempt++) {
			const signal = this.timeoutSignal(opts?.timeoutMs);
			// Recorded before the await, not after: if this attempt is the one that
			// hangs until the deadline, the attempt count is the only thing that
			// distinguishes "the first call stalled" from "we burned the whole
			// RBAC retry budget and the last one stalled".
			span.setAttribute("cyrus.aca.attempt", attempt);
			const r = await this.fetchFn(url, signal ? { ...init, signal } : init);
			lastStatus = r.status;
			span.setAttribute("http.response.status_code", r.status);
			const text = await r.text();
			let parsed: unknown;
			if (text) {
				try {
					parsed = JSON.parse(text);
				} catch {
					parsed = text;
				}
			}
			if (r.status === 403 && attempt < RBAC_403_RETRY_MAX) {
				lastBody = parsed;
				await this.sleepFn(RBAC_403_RETRY_DELAY_MS);
				continue;
			}
			if (r.status === 404 && opts?.okOn404) return null;
			if (r.status >= 200 && r.status < 300) return (parsed as T) ?? null;
			// Surface non-2xx. 404-when-not-allowed also lands here.
			throw new AcaApiError(r.status, parsed);
		}
		throw new AcaApiError(lastStatus, lastBody);
	}

	private buildUrl(path: string, query?: Record<string, string>): string {
		const u = new URL(path, this.baseUrl);
		if (!u.searchParams.has("api-version")) {
			u.searchParams.set("api-version", this.apiVersion);
		}
		if (query) {
			for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
		}
		return u.toString();
	}

	/** Normalise either `[]` or `{value:[...]}` to an array. */
	private asArray<T>(body: unknown): T[] {
		if (Array.isArray(body)) return body as T[];
		if (
			body &&
			typeof body === "object" &&
			Array.isArray((body as { value?: unknown }).value)
		) {
			return (body as { value: T[] }).value;
		}
		return [];
	}

	private async listAll<T>(
		path: string,
		query?: Record<string, string>,
	): Promise<T[]> {
		const out: T[] = [];
		let next: string | undefined = path;
		let first = true;
		while (next) {
			const body: unknown = await this.request<unknown>(
				"GET",
				next,
				undefined,
				first && query ? { query } : undefined,
			);
			out.push(...this.asArray<T>(body));
			next =
				body && !Array.isArray(body) && typeof body === "object"
					? ((body as { nextLink?: unknown }).nextLink as string | undefined)
					: undefined;
			first = false;
		}
		return out;
	}

	async getSandbox(id: string): Promise<AcaSandbox | null> {
		return this.request<AcaSandbox>(
			"GET",
			`${this.root}/sandboxes/${id}`,
			undefined,
			{
				okOn404: true,
			},
		);
	}

	async listSandboxes(labels?: Record<string, string>): Promise<AcaSandbox[]> {
		const query = labels ? { labels: this.encodeLabels(labels) } : undefined;
		return this.listAll<AcaSandbox>(`${this.root}/sandboxes`, query);
	}

	private encodeLabels(labels: Record<string, string>): string {
		return Object.entries(labels)
			.map(([k, v]) => `${k}=${v}`)
			.join(",");
	}

	async createSandbox(b: AcaSandboxCreateBody): Promise<AcaSandbox> {
		const sourceCount = [b.diskImageName, b.diskImageId, b.snapshotId].filter(
			Boolean,
		).length;
		if (sourceCount !== 1) {
			throw new Error(
				"createSandbox requires exactly one of diskImageName, diskImageId, or snapshotId",
			);
		}
		const body: Record<string, unknown> = {};
		if (b.diskImageName) {
			const diskImage: Record<string, unknown> = { name: b.diskImageName };
			if (b.diskImageIsPublic !== undefined)
				diskImage.isPublic = b.diskImageIsPublic;
			body.sourcesRef = { diskImage };
		} else if (b.diskImageId) {
			body.sourcesRef = { diskImage: { id: b.diskImageId } };
		} else if (b.snapshotId) {
			body.sourcesRef = { snapshot: { id: b.snapshotId } };
		}
		if (b.environment !== undefined) body.environment = b.environment;
		if (b.resources !== undefined) body.resources = b.resources;
		if (b.lifecycle !== undefined) body.lifecycle = b.lifecycle;
		if (b.labels !== undefined) body.labels = b.labels;
		if (b.egressPolicy !== undefined) body.egressPolicy = b.egressPolicy;
		if (b.entrypoint !== undefined) body.entrypoint = b.entrypoint;
		if (b.cmd !== undefined) body.cmd = b.cmd;

		// PUT is synchronous per the spike; we capture headers via a raw
		// fetch so we can route the 202 fallback. The request helper
		// returns already-parsed JSON, so do this one inline.
		const token = await this.tokenProvider();
		const url = this.buildUrl(`${this.root}/sandboxes`);
		const init: RequestInit = {
			method: "PUT",
			headers: {
				authorization: `Bearer ${token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify(body),
		};

		for (let attempt = 0; attempt <= RBAC_403_RETRY_MAX; attempt++) {
			const signal = this.timeoutSignal();
			const r = await this.fetchFn(url, signal ? { ...init, signal } : init);
			if (r.status === 403 && attempt < RBAC_403_RETRY_MAX) {
				await this.sleepFn(RBAC_403_RETRY_DELAY_MS);
				continue;
			}
			if (r.status < 200 || r.status >= 300) {
				const text = await r.text();
				let parsed: unknown = text;
				if (text) {
					try {
						parsed = JSON.parse(text);
					} catch {
						/* keep as text */
					}
				}
				throw new AcaApiError(r.status, parsed);
			}
			// Sync success
			if (r.status === 200 || r.status === 201) {
				const text = await r.text();
				const sandbox = text ? JSON.parse(text) : {};
				if (this.isStateTerminal(sandbox)) return sandbox as AcaSandbox;
				if (typeof sandbox.id !== "string" || sandbox.id.length === 0) {
					throw new AcaApiError(r.status, {
						title: "Nonterminal sandbox create response omitted id",
					});
				}
				return this.pollUntilTerminal(
					this.buildUrl(`${this.root}/sandboxes/${sandbox.id}`),
				);
			}
			// 202 fallback — defensive, never exercised in the spike.
			if (r.status === 202) {
				const pollUrl =
					r.headers.get("azure-asyncoperation") ?? r.headers.get("location");
				if (!pollUrl) {
					throw new AcaApiError(202, {
						title:
							"Async sandbox create response omitted Location and azure-asyncoperation",
					});
				}
				return this.pollUntilTerminal(pollUrl);
			}
			// Any other 2xx: best-effort return whatever was sent.
			const text = await r.text();
			return (text ? JSON.parse(text) : {}) as AcaSandbox;
		}
		throw new AcaApiError(403, undefined);
	}

	private isStateTerminal(sandbox: unknown): boolean {
		if (sandbox && typeof sandbox === "object") {
			const state = (sandbox as { state?: string }).state;
			return state !== undefined && TERMINAL_STATES.has(state);
		}
		return false;
	}

	private async pollUntilTerminal(pollUrl: string): Promise<AcaSandbox> {
		const token = await this.tokenProvider();
		const u = new URL(this.buildUrl(pollUrl));
		const headers = { authorization: `Bearer ${token}` };
		for (let i = 0; i < LRO_MAX_POLLS; i++) {
			const r = await this.fetchFn(u.toString(), { method: "GET", headers });
			if (r.status >= 200 && r.status < 300) {
				const text = await r.text();
				const parsed = text ? JSON.parse(text) : {};
				const state = (parsed as { state?: string }).state;
				if (state === "Running" || state === "Failed")
					return parsed as AcaSandbox;
				if (this.isStateTerminal(parsed)) return parsed as AcaSandbox;
			}
			await this.sleepFn(LRO_POLL_INTERVAL_MS);
		}
		throw new AcaApiError(0, { title: "LRO polling timed out" });
	}

	/**
	 * C7: /stop REQUIRES a JSON body. A `Content-Length: 0` request hangs
	 * until the client timeout (~120s+). Sending `{}` with content-type
	 * `application/json` returns in ~6s. Same applies to /resume.
	 */
	async stopSandbox(id: string): Promise<void> {
		await this.request(
			"POST",
			`${this.root}/sandboxes/${id}/stop`,
			{},
			{ timeoutMs: SLOW_OPERATION_TIMEOUT_MS },
		);
	}

	/** C7: same body-required quirk as {@link stopSandbox}. */
	async resumeSandbox(id: string): Promise<void> {
		await this.request(
			"POST",
			`${this.root}/sandboxes/${id}/resume`,
			{},
			{ timeoutMs: SLOW_OPERATION_TIMEOUT_MS },
		);
	}

	/**
	 * DELETE is idempotent per the spike (first 200, second 204, never 404).
	 * We tolerate 404 anyway because callers may race a destroy against a
	 * sweep that already removed the sandbox.
	 */
	async deleteSandbox(id: string): Promise<void> {
		await this.request("DELETE", `${this.root}/sandboxes/${id}`, undefined, {
			okOn404: true,
		});
	}

	async setLifecycle(id: string, policy: AcaLifecyclePolicy): Promise<void> {
		await this.request(
			"POST",
			`${this.root}/sandboxes/${id}/lifecycle`,
			policy,
		);
	}

	async listSnapshots(labels?: Record<string, string>): Promise<AcaSnapshot[]> {
		const query = labels ? { labels: this.encodeLabels(labels) } : undefined;
		return this.listAll<AcaSnapshot>(`${this.root}/snapshots`, query);
	}

	async createSnapshot(
		sandboxId: string,
		labels?: Record<string, string>,
	): Promise<AcaSnapshot> {
		const body = labels !== undefined ? { labels } : {};
		const r = await this.request<AcaSnapshot>(
			"POST",
			`${this.root}/sandboxes/${sandboxId}/snapshot`,
			body,
			{ timeoutMs: SLOW_OPERATION_TIMEOUT_MS },
		);
		return r ?? ({} as AcaSnapshot);
	}

	/** Snapshot/disk-image DELETE returns 202 (async); 2xx + 404 both OK. */
	async deleteSnapshot(id: string): Promise<void> {
		await this.request("DELETE", `${this.root}/snapshots/${id}`, undefined, {
			okOn404: true,
		});
	}

	async listDiskImages(): Promise<AcaDiskImage[]> {
		return this.listAll<AcaDiskImage>(`${this.root}/diskimages`);
	}

	/**
	 * Registers a disk image, in the shape `aca sandboxgroup disk create`
	 * itself sends. Three details are load-bearing and each fails in a way that
	 * names something other than itself (NOR-337):
	 *
	 * - `registryCredentials` is a SIBLING of `image`, never a member of it.
	 *   Nested inside `image` the field is never read, an anonymous pull is
	 *   attempted against a private ACR, and the answer is `401
	 *   RegistryAuthFailed` asking for the very field that was sent — so every
	 *   credential VALUE gets tried in turn and all fail identically.
	 * - the requested name goes in `labels.name`, not at the top level: the
	 *   server assigns its own GUID as `name`, and the label is what it
	 *   preserves and what every lookup here matches on.
	 * - the credential field is `token`, NOT `password`, which returns a fast
	 *   400 naming the required property and reads like a malformed body.
	 *
	 * The import is SYNCHRONOUS and scales with image size (measured: 1.7 GB in
	 * 99s), which is why this uses the slow-operation deadline. A 2xx says the
	 * request was accepted, not that the image imported — gate on
	 * {@link waitForDiskImageReady}, never on the status code.
	 */
	async createDiskImage(
		name: string,
		image: string,
		opts?: {
			isPublic?: boolean;
			registryCredentials?: { username: string; token: string };
		},
	): Promise<AcaDiskImage> {
		const img: Record<string, unknown> = { base: image };
		if (opts?.isPublic !== undefined) img.isPublic = opts.isPublic;
		const body: Record<string, unknown> = { labels: { name }, image: img };
		if (opts?.registryCredentials) {
			body.registryCredentials = opts.registryCredentials;
		}
		const r = await this.request<AcaDiskImage>(
			"PUT",
			`${this.root}/diskimages`,
			body,
			{ timeoutMs: SLOW_OPERATION_TIMEOUT_MS },
		);
		return r ?? ({} as AcaDiskImage);
	}

	/** Disk-image DELETE returns 202 (async); 2xx + 404 both OK. */
	async deleteDiskImage(id: string): Promise<void> {
		await this.request("DELETE", `${this.root}/diskimages/${id}`, undefined, {
			okOn404: true,
		});
	}

	/**
	 * Polls until the named disk reports `Ready`.
	 *
	 * The authoritative signal is the disk appearing in the list with that
	 * state — a 2xx on the PUT only says the request was accepted, and the
	 * import can still fail server-side minutes later.
	 */
	async waitForDiskImageReady(
		name: string,
		opts: {
			timeoutMs: number;
			pollMs: number;
			sleepFn?: (ms: number) => Promise<void>;
			now?: () => number;
		},
	): Promise<AcaDiskImage> {
		const sleep =
			opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
		const now = opts.now ?? (() => Date.now());
		const deadline = now() + opts.timeoutMs;
		let lastState = "";
		while (now() < deadline) {
			const found = (await this.listDiskImages()).find(
				(d) => d.name === name || d.labels?.name === name,
			);
			const state =
				typeof found?.status === "string"
					? found.status
					: (found?.status?.state ?? "");
			if (found && state === "Ready") return found;
			if (state === "Failed" || state === "Error") {
				throw new Error(
					`disk image ${name} reached state '${state}'${
						typeof found?.status === "object" && found.status?.errorMessage
							? `: ${found.status.errorMessage}`
							: ""
					}`,
				);
			}
			lastState = state;
			await sleep(opts.pollMs);
		}
		throw new Error(
			`disk image ${name} did not reach Ready within ${opts.timeoutMs}ms (last state: '${lastState || "absent"}')`,
		);
	}
}

/**
 * Reduce a request path to a LOW-CARDINALITY operation name for the span.
 *
 * A span attribute that is unique per call is a column full of noise: you
 * cannot group by it, average over it, or alert on it, and in a backend that
 * indexes attributes it is pure cost. The raw path is exactly that — it carries
 * a subscription id, a resource group, a sandbox group and a server-assigned
 * sandbox GUID, so every call produces a distinct value.
 *
 * The ARM prefix is stripped rather than templated because it is invariant for
 * a given deployment: it identifies the router's own sandbox group, which is
 * already implied by `service.name` and `cloud.region`, and it is the longest
 * part of the string. What remains — `sandboxes/{id}/stop`, `snapshots`,
 * `diskimages` — is the part that says what the call was actually for.
 *
 * The concrete sandbox id is deliberately NOT re-added as its own attribute
 * here. `AcaSandboxesProvider` already stamps `cyrus.issue_key` on the spans
 * above this one, and the issue key is the identifier an operator has in hand;
 * the ACA GUID is a lookup away from it and nobody starts a debugging session
 * holding one.
 */
function operationTemplate(path: string): string {
	// Everything up to and including the sandbox group is deployment-invariant.
	const afterGroup = path.replace(
		/^\/subscriptions\/[^/]+\/resourceGroups\/[^/]+\/sandboxGroups\/[^/]+\/?/,
		"",
	);
	const trimmed = (afterGroup || path).replace(/^\/+/, "");
	if (!trimmed) return "sandboxGroup";
	// Collapse identifier segments. A sandbox name is a server-assigned GUID and
	// a snapshot/disk-image name is user-chosen, so both are matched positionally
	// — the segment after a known collection — rather than by trying to
	// recognise the value, which would let a well-formed name slip through as a
	// literal and split one operation into two.
	return trimmed
		.split("/")
		.map((segment, index, all) => {
			if (index === 0) return segment;
			const parent = all[index - 1];
			return parent === "sandboxes" ||
				parent === "snapshots" ||
				parent === "diskimages"
				? "{name}"
				: segment;
		})
		.join("/");
}
