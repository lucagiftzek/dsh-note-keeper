// RemoteClient: a thin, transport-agnostic client for the Note Keeper Sync
// protocol (docs/SYNC-PROTOCOL.md). No Node APIs; talks HTTP through an
// injected Transport so production code uses obsidian.requestUrl (works on
// mobile, bypasses CORS) while tests use plain fetch against a real server.

import { hmacB64url, randomNonce, sha256Hex } from "./crypto.ts";

/** One HTTP request, already fully formed (method, absolute URL, headers,
 * optional binary body). Nothing here is Node-specific. */
export interface TransportRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: Uint8Array;
}

/** One HTTP response. body is always a raw byte buffer; callers decode JSON
 * or text themselves so binary file bodies are not mangled. */
export interface TransportResponse {
	status: number;
	headers: Record<string, string>; // keys are lower-cased
	body: Uint8Array;
}

export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** Raised for any non-2xx/304/404-as-success response the caller did not
 * ask to handle explicitly (auth failures, 400s, 5xx, network errors). */
export class RemoteError extends Error {
	readonly status: number;
	readonly body?: unknown;

	constructor(message: string, status: number, body?: unknown) {
		super(message);
		this.name = "RemoteError";
		this.status = status;
		this.body = body;
	}
}

export interface DeviceIdentity {
	name: string;
	platform: string;
	app: string;
}

export interface PairResult {
	deviceId: string;
	secret: string;
	vault: string;
	protocol: number;
	name: string;
}

export interface ManifestEntry {
	path: string;
	size: number;
	mtime: number; // unix ms
	hash: string; // hex sha256
}

export type ManifestResult =
	| { notModified: true }
	| { notModified: false; version: string; files: ManifestEntry[] };

export interface GetResult {
	data: Uint8Array;
	hash: string;
	mtime: number;
}

export type PutResult =
	| { ok: true; hash: string; mtime: number }
	| { ok: false; kind: "conflict"; current: { hash: string; mtime: number } }
	| { ok: false; kind: "locked" }
	| { ok: false; kind: "tooLarge" };

export type DeleteResult =
	| { ok: true }
	| { ok: false; kind: "conflict"; current: { hash: string; mtime: number } };

/** Signed HTTP client for one Note Keeper Sync device. Construct one per
 * paired device; call setCredentials() after pair() or when loading saved
 * settings, before any authenticated call. */
export class RemoteClient {
	private readonly origin: string;
	private readonly prefix: string; // e.g. "/nk-sync", no trailing slash
	private readonly transport: Transport;
	private deviceId = "";
	private secret = "";

	constructor(baseUrl: string, transport: Transport) {
		this.transport = transport;
		const u = new URL(baseUrl);
		this.origin = u.origin;
		this.prefix = u.pathname.replace(/\/+$/, "");
	}

	/** Installs credentials obtained from pair() or persisted settings. */
	setCredentials(deviceId: string, secret: string): void {
		this.deviceId = deviceId;
		this.secret = secret;
	}

	hasCredentials(): boolean {
		return this.deviceId !== "" && this.secret !== "";
	}

	get currentDeviceId(): string {
		return this.deviceId;
	}

	/** GET /v1/hello — unauthenticated liveness/identity check. */
	async hello(): Promise<{ server: string; protocol: number }> {
		const res = await this.transport({
			method: "GET",
			url: this.origin + this.prefix + "/v1/hello",
			headers: {}
		});
		if (res.status !== 200) throw errorFor(res);
		return JSON.parse(bytesToText(res.body));
	}

	/** POST /v1/pair — unauthenticated; redeems a one-time pairing code.
	 * On success this also installs the returned credentials on the client. */
	async pair(code: string, device: DeviceIdentity): Promise<PairResult> {
		const body = jsonBody({ code, device });
		const res = await this.transport({
			method: "POST",
			url: this.origin + this.prefix + "/v1/pair",
			headers: { "Content-Type": "application/json" },
			body
		});
		if (res.status !== 200) throw errorFor(res);
		const result = JSON.parse(bytesToText(res.body)) as PairResult;
		this.setCredentials(result.deviceId, result.secret);
		return result;
	}

	/** GET /v1/whoami */
	async whoami(): Promise<{ deviceId: string; name: string; vault: string }> {
		const res = await this.authed("GET", "/v1/whoami", []);
		if (res.status !== 200) throw errorFor(res);
		return JSON.parse(bytesToText(res.body));
	}

	/** GET /v1/manifest, with If-None-Match support. Pass the ETag (without
	 * quotes) you stored from a previous call's "version" to get 304s. */
	async manifest(etag?: string): Promise<ManifestResult> {
		const extraHeaders: Record<string, string> = {};
		if (etag) extraHeaders["If-None-Match"] = '"' + etag + '"';
		const res = await this.authed("GET", "/v1/manifest", [], undefined, extraHeaders);
		if (res.status === 304) return { notModified: true };
		if (res.status !== 200) throw errorFor(res);
		const parsed = JSON.parse(bytesToText(res.body)) as { version: string; files: ManifestEntry[] };
		return { notModified: false, version: parsed.version, files: parsed.files };
	}

	/** GET /v1/file?path=P — raw bytes plus the server's hash/mtime for them. */
	async get(path: string): Promise<GetResult> {
		const res = await this.authed("GET", "/v1/file", [["path", path]]);
		if (res.status !== 200) throw errorFor(res);
		return {
			data: res.body,
			hash: res.headers["x-nk-hash"] ?? "",
			mtime: Number(res.headers["x-nk-mtime"] ?? "0")
		};
	}

	/** PUT /v1/file?path=P&base=H&mtime=M — compare-and-swap write.
	 * base = the hash this client last saw ("" for "must not exist yet"). */
	async put(path: string, data: Uint8Array, base: string, mtime: number): Promise<PutResult> {
		const res = await this.authed(
			"PUT",
			"/v1/file",
			[
				["path", path],
				["base", base],
				["mtime", String(Math.trunc(mtime))]
			],
			data
		);
		if (res.status === 200) {
			const parsed = JSON.parse(bytesToText(res.body)) as { hash: string; mtime: number };
			return { ok: true, hash: parsed.hash, mtime: parsed.mtime };
		}
		if (res.status === 409) {
			const parsed = JSON.parse(bytesToText(res.body)) as { current: { hash: string; mtime: number } };
			return { ok: false, kind: "conflict", current: parsed.current };
		}
		if (res.status === 423) return { ok: false, kind: "locked" };
		if (res.status === 413) return { ok: false, kind: "tooLarge" };
		throw errorFor(res);
	}

	/** DELETE /v1/file?path=P&base=H — moves the file to .trash.
	 * A 404 (already gone) is treated as success, per protocol. */
	async del(path: string, base: string): Promise<DeleteResult> {
		const res = await this.authed("DELETE", "/v1/file", [
			["path", path],
			["base", base]
		]);
		if (res.status === 200 || res.status === 404) return { ok: true };
		if (res.status === 409) {
			const parsed = JSON.parse(bytesToText(res.body)) as { current: { hash: string; mtime: number } };
			return { ok: false, kind: "conflict", current: parsed.current };
		}
		throw errorFor(res);
	}

	// ---- signing --------------------------------------------------------

	private async authed(
		method: string,
		path: string,
		query: [string, string][],
		body?: Uint8Array,
		extraHeaders?: Record<string, string>
	): Promise<TransportResponse> {
		if (!this.hasCredentials()) {
			throw new RemoteError("not paired: no device credentials", 0);
		}
		const requestPath = this.prefix + path;
		const queryString = buildQuery(query);
		const requestUri = requestPath + queryString;
		const bytes = body ?? new Uint8Array(0);
		const bodyHash = await sha256Hex(bytes);
		const ts = String(Math.floor(Date.now() / 1000));
		const nonce = randomNonce();
		const message = ["NK1", method, requestUri, ts, nonce, bodyHash].join("\n");
		const signature = await hmacB64url(this.secret, message);
		const headers: Record<string, string> = {
			"X-NK-Device": this.deviceId,
			"X-NK-Time": ts,
			"X-NK-Nonce": nonce,
			"X-NK-Body-SHA256": bodyHash,
			"X-NK-Signature": signature,
			...(extraHeaders ?? {})
		};
		if (body !== undefined) headers["Content-Type"] = "application/octet-stream";
		return this.transport({
			method,
			url: this.origin + requestUri,
			headers,
			body
		});
	}
}

/** Builds a query string the same way the plugin signs it: keys and values
 * both run through encodeURIComponent, per docs/SYNC-PROTOCOL.md. Always
 * returns a leading "?" when there is at least one entry (the protocol
 * examples always include "base=", even when empty). */
function buildQuery(entries: [string, string][]): string {
	if (entries.length === 0) return "";
	return (
		"?" +
		entries.map(([k, v]) => encodeURIComponent(k) + "=" + encodeURIComponent(v)).join("&")
	);
}

function jsonBody(v: unknown): Uint8Array {
	return new TextEncoder().encode(JSON.stringify(v));
}

function bytesToText(b: Uint8Array): string {
	return new TextDecoder().decode(b);
}

function errorFor(res: TransportResponse): RemoteError {
	let message = "request failed with status " + res.status;
	let parsedBody: unknown;
	try {
		const text = bytesToText(res.body);
		parsedBody = text ? JSON.parse(text) : undefined;
		if (parsedBody && typeof parsedBody === "object" && "error" in parsedBody) {
			message = String((parsedBody as { error: unknown }).error);
		}
	} catch {
		// non-JSON body; keep the generic message
	}
	return new RemoteError(message, res.status, parsedBody);
}

/** Builds a Transport backed by obsidian.requestUrl, which works on mobile
 * (WKWebView on iOS has no XHR/fetch CORS bypass, requestUrl does) and never
 * throws on a non-2xx status (throw: false), matching this client's needs.
 * Takes the requestUrl function as a parameter so this module never imports
 * "obsidian" itself, keeping it usable from plain Node tests too. */
export function makeObsidianTransport(requestUrlFn: (params: any) => Promise<any>): Transport {
	return async (req: TransportRequest): Promise<TransportResponse> => {
		const res = await requestUrlFn({
			url: req.url,
			method: req.method,
			headers: req.headers,
			body: req.body ? arrayBufferOf(req.body) : undefined,
			throw: false
		});
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries<string>(res.headers ?? {})) {
			headers[k.toLowerCase()] = v;
		}
		const body = res.arrayBuffer ? new Uint8Array(res.arrayBuffer) : new Uint8Array(0);
		return { status: res.status, headers, body };
	};
}

function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Builds a Transport backed by the global fetch() — used by integration
 * tests (Node) against a real notekeeperd instance. Never used at runtime
 * inside Obsidian (fetch is CORS-limited and unavailable in some mobile
 * contexts); production always uses makeObsidianTransport. */
export function makeFetchTransport(fetchFn: typeof fetch = fetch): Transport {
	return async (req: TransportRequest): Promise<TransportResponse> => {
		const res = await fetchFn(req.url, {
			method: req.method,
			headers: req.headers,
			body: req.body as any
		});
		const headers: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			headers[k.toLowerCase()] = v;
		});
		const buf = new Uint8Array(await res.arrayBuffer());
		return { status: res.status, headers, body: buf };
	};
}