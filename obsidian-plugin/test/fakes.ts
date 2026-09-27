// Shared in-memory fakes for the sync engine tests: no filesystem, no
// network. Deterministic under an injected clock.

import type {
	LocalFS,
	LocalFileInfo,
	RemoteSyncClient
} from "../src/engine.ts";
import type { DeleteResult, GetResult, ManifestEntry, ManifestResult, PutResult } from "../src/remote.ts";
import { sha256Hex } from "../src/crypto.ts";

interface StoredFile {
	data: Uint8Array;
	mtime: number;
}

/** In-memory LocalFS: a Map keyed by vault-relative path. */
export class FakeLocalFS implements LocalFS {
	files = new Map<string, StoredFile>();
	removed: string[] = [];

	static fromEntries(entries: Record<string, { text: string; mtime: number }>): FakeLocalFS {
		const fs = new FakeLocalFS();
		for (const [path, v] of Object.entries(entries)) {
			fs.files.set(path, { data: new TextEncoder().encode(v.text), mtime: v.mtime });
		}
		return fs;
	}

	async list(): Promise<LocalFileInfo[]> {
		return [...this.files.entries()].map(([path, f]) => ({ path, size: f.data.byteLength, mtime: f.mtime }));
	}

	async read(path: string): Promise<Uint8Array> {
		const f = this.files.get(path);
		if (!f) throw new Error(`not found: ${path}`);
		return f.data;
	}

	async write(path: string, data: Uint8Array, mtime: number): Promise<void> {
		this.files.set(path, { data, mtime });
	}

	async remove(path: string): Promise<void> {
		this.files.delete(path);
		this.removed.push(path);
	}

	async rename(from: string, to: string): Promise<void> {
		const f = this.files.get(from);
		if (!f) throw new Error(`not found: ${from}`);
		this.files.delete(from);
		this.files.set(to, f);
	}

	async exists(path: string): Promise<boolean> {
		return this.files.has(path);
	}
}

interface RemoteStoredFile {
	data: Uint8Array;
	hash: string;
	mtime: number;
}

/** In-memory RemoteSyncClient with the server's real CAS semantics
 * (hash-based optimistic concurrency), so the engine's push/pull/delete
 * paths are exercised the same way they would be against notekeeperd. */
export class FakeRemote implements RemoteSyncClient {
	files = new Map<string, RemoteStoredFile>();
	/** Paths that should answer 423 "locked" on the next PUT (simulates an
	 * encrypted folder refusing a plaintext write). */
	lockedPaths = new Set<string>();
	/** Paths that should answer 409 on the very next PUT/DELETE (simulates
	 * another device racing this one). Consumed after one use. */
	forceConflictOnce = new Set<string>();

	static async fromEntries(entries: Record<string, { text: string; mtime: number }>): Promise<FakeRemote> {
		const r = new FakeRemote();
		for (const [path, v] of Object.entries(entries)) {
			const data = new TextEncoder().encode(v.text);
			r.files.set(path, { data, hash: await sha256Hex(data), mtime: v.mtime });
		}
		return r;
	}

	async manifest(_etag?: string): Promise<ManifestResult> {
		const files: ManifestEntry[] = [...this.files.entries()].map(([path, f]) => ({
			path,
			size: f.data.byteLength,
			mtime: f.mtime,
			hash: f.hash
		}));
		return { notModified: false, version: String(files.length) + ":" + files.map((f) => f.hash).join(","), files };
	}

	async get(path: string): Promise<GetResult> {
		const f = this.files.get(path);
		if (!f) throw new Error(`not found: ${path}`);
		return { data: f.data, hash: f.hash, mtime: f.mtime };
	}

	async put(path: string, data: Uint8Array, base: string, mtime: number): Promise<PutResult> {
		if (this.forceConflictOnce.delete(path)) {
			const cur = this.files.get(path);
			return { ok: false, kind: "conflict", current: { hash: cur?.hash ?? "", mtime: cur?.mtime ?? 0 } };
		}
		if (this.lockedPaths.has(path)) {
			return { ok: false, kind: "locked" };
		}
		const cur = this.files.get(path);
		const curHash = cur?.hash ?? "";
		if (curHash !== base) {
			return { ok: false, kind: "conflict", current: { hash: curHash, mtime: cur?.mtime ?? 0 } };
		}
		const hash = await sha256Hex(data);
		this.files.set(path, { data, hash, mtime });
		return { ok: true, hash, mtime };
	}

	async del(path: string, base: string): Promise<DeleteResult> {
		if (this.forceConflictOnce.delete(path)) {
			const cur = this.files.get(path);
			return { ok: false, kind: "conflict", current: { hash: cur?.hash ?? "", mtime: cur?.mtime ?? 0 } };
		}
		const cur = this.files.get(path);
		if (!cur) return { ok: true }; // already gone: success, per protocol
		if (cur.hash !== base) {
			return { ok: false, kind: "conflict", current: { hash: cur.hash, mtime: cur.mtime } };
		}
		this.files.delete(path);
		return { ok: true };
	}
}