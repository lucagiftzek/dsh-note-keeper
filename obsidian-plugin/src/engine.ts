// Pure, transport-agnostic sync engine implementing the three-way decision
// table from docs/SYNC-PROTOCOL.md §"Client algorithm (three-way)". Knows
// nothing about Obsidian: it drives a LocalFS and a RemoteSyncClient and can
// be exercised entirely with in-memory fakes (see test/engine.test.ts).

import { sha256Hex } from "./crypto.ts";
import type { DeleteResult, GetResult, ManifestResult, PutResult } from "./remote.ts";

/** One entry the engine needs from a local file listing. */
export interface LocalFileInfo {
	/** Vault-relative, "/"-separated path (never starts with "/"). */
	path: string;
	size: number;
	/** Unix milliseconds. */
	mtime: number;
}

/** Local filesystem operations the engine needs. Implemented over
 * app.vault.adapter in src/obsidian-fs.ts; trivially faked in-memory for
 * unit tests. All paths are vault-relative, "/"-separated. */
export interface LocalFS {
	list(): Promise<LocalFileInfo[]>;
	read(path: string): Promise<Uint8Array>;
	/** Writes content, then sets the file's mtime to the given value
	 * (unix ms) so both sides agree on modification time after a sync. */
	write(path: string, data: Uint8Array, mtime: number): Promise<void>;
	/** Removes a file (to the platform trash, never a hard delete). */
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	exists(path: string): Promise<boolean>;
}

/** The subset of RemoteClient the engine drives. Matches remote.ts's
 * RemoteClient method signatures exactly so a real RemoteClient can be
 * passed directly. */
export interface RemoteSyncClient {
	manifest(etag?: string): Promise<ManifestResult>;
	get(path: string): Promise<GetResult>;
	put(path: string, data: Uint8Array, base: string, mtime: number): Promise<PutResult>;
	del(path: string, base: string): Promise<DeleteResult>;
}

/** One row of the sync log (surfaced in the plugin's "Show sync log" modal). */
export interface SyncLogEntry {
	timestamp: number;
	path: string;
	action:
		| "push"
		| "pull"
		| "delete-local"
		| "delete-remote"
		| "conflict"
		| "skip"
		| "error";
	detail?: string;
}

export interface SyncSummary {
	ok: boolean;
	aborted?: { reason: "mass-delete"; deletions: number; total: number };
	entries: SyncLogEntry[];
	pushed: number;
	pulled: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	skipped: number;
	errors: number;
	/** The remote manifest ETag this run observed (undefined when aborted
	 * before a manifest fetch). Callers may persist it and pass it to a
	 * cheap remote.manifest(etag) precheck before the next runOnce(). */
	manifestVersion?: string;
}

/** Per-call options for runOnce(), separate from the engine's constructor
 * options so a one-shot override (like "allow this one mass deletion") does
 * not require rebuilding the engine and losing its warm hash cache. */
export interface RunOptions {
	allowMassDelete?: boolean;
}

export interface EngineOptions {
	local: LocalFS;
	remote: RemoteSyncClient;
	/** Name used in conflict-copy filenames, e.g. "iPhone" or "MacBook". */
	deviceName: string;
	/** Folder that holds Obsidian's own config (default ".obsidian"),
	 * excluded from sync even if it is not dot-prefixed. */
	configDir?: string;
	/** Additional vault-relative folder prefixes the user asked to exclude. */
	excludePrefixes?: string[];
	/** One-shot override for the deletion guard (see runOnce doc). */
	allowMassDelete?: boolean;
	/** Called after each op whose base-map entry changed, so the host can
	 * persist it immediately: an interrupted sync resumes safely because
	 * every completed op is durable before the next one starts. hash=null
	 * means "forget this path" (both sides now agree it does not exist). */
	onBaseChange?: (path: string, hash: string | null) => void | Promise<void>;
	/** Clock, injectable for deterministic tests. Unix ms. */
	now?: () => number;
}

/** Bytes above which a file is skipped rather than transferred, matching the
 * server's MaxSyncBytes (95 MB, Cloudflare's ceiling is 100 MB). */
export const MAX_SYNC_BYTES = 95 * 1024 * 1024;

/** Files beyond this fraction of all synced paths, and more than
 * DELETION_GUARD_MIN_COUNT files, will not be deleted without an explicit
 * allowMassDelete override (protects against e.g. a botched vault move
 * being read as "everything got deleted"). */
const DELETION_GUARD_FRACTION = 0.5;
const DELETION_GUARD_MIN_COUNT = 10;

type Hash = string | null;

type Counts = {
	pushed: number;
	pulled: number;
	deletedLocal: number;
	deletedRemote: number;
	conflicts: number;
	skipped: number;
	errors: number;
};

interface PlannedOp {
	path: string;
	kind:
		| "noop"
		| "pull"
		| "push"
		| "delete-local"
		| "delete-remote"
		| "pull-over-local-delete"
		| "push-over-remote-delete"
		| "conflict";
	local?: LocalFileInfo;
	remoteHash?: string;
	remoteSize?: number;
	base: Hash;
}

/** Classifies one path per docs/SYNC-PROTOCOL.md's three-way table. Rows are
 * checked in the document's order; the first match wins. */
function classify(local: Hash, remote: Hash, base: Hash): PlannedOp["kind"] {
	if (local === remote) return "noop"; // Row 1 (covers both-absent too)
	if (local === base && remote !== base) return remote === null ? "delete-local" : "pull"; // Row 2
	if (remote === base && local !== base) return local === null ? "delete-remote" : "push"; // Row 3
	if (local === null && remote !== base) return "pull-over-local-delete"; // Row 4
	if (remote === null && local !== base) return "push-over-remote-delete"; // Row 5
	return "conflict"; // Row 6: otherwise
}

/** In-memory content-hash cache keyed by (size, mtime) so unchanged files
 * are never re-hashed on a later sync pass within the same session. */
class HashCache {
	private readonly entries = new Map<string, { size: number; mtime: number; hash: string }>();

	async hashOf(path: string, size: number, mtime: number, read: () => Promise<Uint8Array>): Promise<string> {
		const cached = this.entries.get(path);
		if (cached && cached.size === size && cached.mtime === mtime) return cached.hash;
		const data = await read();
		const hash = await sha256Hex(data);
		this.entries.set(path, { size, mtime, hash });
		return hash;
	}

	forget(path: string): void {
		this.entries.delete(path);
	}
}

/** Vault-relative path exclusion: hidden segments (dotfiles/dotfolders) are
 * never synced, except the lock-marker basename ".nk-lock.json" which must
 * travel with encrypted folders; the config dir and user-configured prefixes
 * are excluded outright. Mirrors the server's syncable() in manifest.go. */
export function isExcluded(path: string, configDir: string, excludePrefixes: string[]): boolean {
	const segs = path.split("/");
	for (let i = 0; i < segs.length; i++) {
		const seg = segs[i];
		if (seg === "") return true;
		if (seg.startsWith(".")) {
			if (i === segs.length - 1 && seg === ".nk-lock.json") continue;
			return true;
		}
	}
	const prefixes = [configDir, ...excludePrefixes].filter((p) => p && p.length > 0);
	for (const prefix of prefixes) {
		const norm = prefix.replace(/\/+$/, "");
		if (path === norm || path.startsWith(norm + "/")) return true;
	}
	return false;
}

/** Splits "Folder/Name.ext" into ["Folder", "Name", "ext"] (ext without the
 * dot; "" when there is none). Directory is "" for a root-level file. */
function splitPath(path: string): { dir: string; base: string; ext: string } {
	const slash = path.lastIndexOf("/");
	const dir = slash === -1 ? "" : path.slice(0, slash);
	const name = slash === -1 ? path : path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return { dir, base: name, ext: "" };
	return { dir, base: name.slice(0, dot), ext: name.slice(dot + 1) };
}

function pad2(n: number): string {
	return n < 10 ? "0" + n : String(n);
}

/** "Name (conflict <device> YYYY-MM-DD HHmm).ext", per protocol. Uses local
 * time (deterministic under an injected clock in tests). */
function conflictName(path: string, deviceName: string, atMs: number): string {
	const { dir, base, ext } = splitPath(path);
	const d = new Date(atMs);
	const stamp = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}${pad2(d.getMinutes())}`;
	const safeDevice = deviceName.replace(/[\\/:*?"<>|]/g, "_").trim() || "device";
	const newBase = `${base} (conflict ${safeDevice} ${stamp})`;
	const fileName = ext ? `${newBase}.${ext}` : newBase;
	return dir ? `${dir}/${fileName}` : fileName;
}

/** The sync engine. One instance is normally kept for the plugin's whole
 * lifetime so its hash cache stays warm across runs. */
export class SyncEngine {
	private readonly hashCache = new HashCache();
	private readonly opts: EngineOptions;

	constructor(opts: EngineOptions) {
		this.opts = opts;
	}

	/** Runs one full two-way sync pass against the given persisted base map
	 * (path -> last-agreed hash). The map is mutated in place as ops
	 * succeed; onBaseChange is invoked per mutation for durable persistence. */
	async runOnce(base: Map<string, string>, runOptions?: RunOptions): Promise<SyncSummary> {
		const allowMassDelete = runOptions?.allowMassDelete ?? this.opts.allowMassDelete ?? false;
		const { local, remote, configDir = ".obsidian", excludePrefixes = [], now = () => Date.now() } = this.opts;

		const manifestResult = await remote.manifest();
		if (manifestResult.notModified) {
			// Nothing to do: caller should not usually call runOnce with a
			// fresh remote.manifest() unless it wants a full pass; guard anyway.
			return emptySummary();
		}
		const remoteFiles = new Map(manifestResult.files.map((f) => [f.path, f]));
		const localList = await local.list();
		const localFiles = new Map(localList.map((f) => [f.path, f]));

		const included = (p: string) => !isExcluded(p, configDir, excludePrefixes);

		const allPaths = new Set<string>();
		for (const p of localFiles.keys()) if (included(p)) allPaths.add(p);
		for (const p of remoteFiles.keys()) if (included(p)) allPaths.add(p);
		for (const p of base.keys()) if (included(p)) allPaths.add(p);

		// ---- classify every path, then run the deletion guard ----------
		const plans: PlannedOp[] = [];
		for (const path of allPaths) {
			const localInfo = localFiles.get(path);
			const remoteInfo = remoteFiles.get(path);
			const localHash = localInfo
				? await this.hashCache.hashOf(path, localInfo.size, localInfo.mtime, () => local.read(path))
				: null;
			const remoteHash = remoteInfo ? remoteInfo.hash : null;
			const baseHash = base.has(path) ? base.get(path)! : null;
			const kind = classify(localHash, remoteHash, baseHash);
			plans.push({
				path,
				kind,
				local: localInfo,
				remoteHash: remoteInfo?.hash,
				remoteSize: remoteInfo?.size,
				base: baseHash
			});
			if (kind === "noop") {
				// Keep the base map in sync even when nothing transferred:
				// drop stale records, and adopt L===R as the new base so a
				// later divergence has the right starting point.
				if (localHash === null && remoteHash === null) {
					if (baseHash !== null) await this.setBase(base, path, null);
				} else if (baseHash !== localHash) {
					await this.setBase(base, path, localHash);
				}
			}
		}

		const deletions = plans.filter(
			(p) => p.kind === "delete-local" || p.kind === "delete-remote"
		).length;
		const total = plans.length;
		if (
			deletions > DELETION_GUARD_MIN_COUNT &&
			deletions > total * DELETION_GUARD_FRACTION &&
			!allowMassDelete
		) {
			return {
				ok: false,
				aborted: { reason: "mass-delete", deletions, total },
				entries: [
					{
						timestamp: now(),
						path: "",
						action: "error",
						detail: `aborted: this sync would delete ${deletions} of ${total} files; use "Allow one mass-deletion sync" to proceed`
					}
				],
				pushed: 0,
				pulled: 0,
				deletedLocal: 0,
				deletedRemote: 0,
				conflicts: 0,
				skipped: 0,
				errors: 0,
				manifestVersion: manifestResult.version
			};
		}

		// ---- execute -----------------------------------------------------
		const entries: SyncLogEntry[] = [];
		const counts = { pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, skipped: 0, errors: 0 };
		const log = (e: Omit<SyncLogEntry, "timestamp">) => entries.push({ timestamp: now(), ...e });

		for (const plan of plans) {
			try {
				switch (plan.kind) {
					case "noop":
						break;
					case "pull":
						await this.doPull(base, plan, log, counts, now());
						break;
					case "push":
						await this.doPush(base, plan, log, counts, now());
						break;
					case "delete-local":
						await local.remove(plan.path);
						await this.setBase(base, plan.path, null);
						counts.deletedLocal++;
						log({ path: plan.path, action: "delete-local" });
						break;
					case "delete-remote": {
						const res = await remote.del(plan.path, plan.base ?? "");
						if (res.ok) {
							await this.setBase(base, plan.path, null);
							counts.deletedRemote++;
							log({ path: plan.path, action: "delete-remote" });
						} else {
							counts.errors++;
							log({ path: plan.path, action: "error", detail: "delete conflict on server; will retry next sync" });
						}
						break;
					}
					case "pull-over-local-delete":
						await this.doPull(base, plan, log, counts, now(), "restored: edited remotely after being deleted locally");
						break;
					case "push-over-remote-delete":
						await this.doPush(base, plan, log, counts, now(), "", "recreated remotely after being deleted there");
						break;
					case "conflict":
						await this.doConflict(base, plan, log, counts, now());
						break;
				}
			} catch (err) {
				counts.errors++;
				log({ path: plan.path, action: "error", detail: String((err as Error)?.message ?? err) });
			}
		}

		return { ok: true, entries, ...counts, manifestVersion: manifestResult.version };
	}

	private async setBase(base: Map<string, string>, path: string, hash: string | null): Promise<void> {
		if (hash === null) {
			base.delete(path);
		} else {
			base.set(path, hash);
		}
		if (this.opts.onBaseChange) await this.opts.onBaseChange(path, hash);
	}

	private async doPull(
		base: Map<string, string>,
		plan: PlannedOp,
		log: (e: Omit<SyncLogEntry, "timestamp">) => void,
		counts: Counts,
		_now: number,
		detail?: string
	): Promise<void> {
		if ((plan.remoteSize ?? 0) > MAX_SYNC_BYTES) {
			counts.skipped++;
			log({ path: plan.path, action: "skip", detail: "remote file exceeds 95 MB sync limit" });
			return;
		}
		const got = await this.opts.remote.get(plan.path);
		await this.opts.local.write(plan.path, got.data, got.mtime);
		this.hashCache.forget(plan.path);
		await this.setBase(base, plan.path, got.hash);
		counts.pulled++;
		log({ path: plan.path, action: "pull", detail });
	}

	private async doPush(
		base: Map<string, string>,
		plan: PlannedOp,
		log: (e: Omit<SyncLogEntry, "timestamp">) => void,
		counts: Counts,
		_now: number,
		baseOverride?: string,
		detail?: string
	): Promise<void> {
		const local = plan.local;
		if (!local) return; // should not happen: push implies a local file
		if (local.size > MAX_SYNC_BYTES) {
			counts.skipped++;
			log({ path: plan.path, action: "skip", detail: "local file exceeds 95 MB sync limit" });
			return;
		}
		const data = await this.opts.local.read(plan.path);
		const baseHash = baseOverride !== undefined ? baseOverride : plan.base ?? "";
		const result = await this.opts.remote.put(plan.path, data, baseHash, local.mtime);
		if (result.ok) {
			await this.setBase(base, plan.path, result.hash);
			counts.pushed++;
			log({ path: plan.path, action: "push", detail });
			return;
		}
		if (result.kind === "conflict") {
			counts.errors++;
			log({ path: plan.path, action: "error", detail: "push conflict on server; will retry next sync" });
			return;
		}
		if (result.kind === "locked") {
			counts.errors++;
			log({ path: plan.path, action: "error", detail: "encrypted folder refused plaintext" });
			return;
		}
		// tooLarge
		counts.skipped++;
		log({ path: plan.path, action: "skip", detail: "server rejected: file too large" });
	}

	private async doConflict(
		base: Map<string, string>,
		plan: PlannedOp,
		log: (e: Omit<SyncLogEntry, "timestamp">) => void,
		counts: Counts,
		nowMs: number
	): Promise<void> {
		const { local, path, remoteHash } = plan;
		if (!local) return; // conflict always has a local side
		let renamed = conflictName(path, this.opts.deviceName, nowMs);
		let suffix = 2;
		while ((await this.opts.local.exists(renamed))) {
			renamed = conflictName(path, `${this.opts.deviceName} ${suffix}`, nowMs);
			suffix++;
		}
		const data = await this.opts.local.read(path);
		await this.opts.local.rename(path, renamed);
		this.hashCache.forget(path);
		this.hashCache.forget(renamed);

		// Push the local copy under its new, conflict-marked name.
		const pushResult = await this.opts.remote.put(renamed, data, "", local.mtime);
		if (pushResult.ok) {
			await this.setBase(base, renamed, pushResult.hash);
		} else {
			counts.errors++;
			log({ path: renamed, action: "error", detail: "could not push conflict copy; will retry next sync" });
		}

		// Pull the remote version into the original path.
		if ((plan.remoteSize ?? 0) > MAX_SYNC_BYTES) {
			counts.skipped++;
			log({ path, action: "skip", detail: "remote file exceeds 95 MB sync limit" });
		} else {
			const got = await this.opts.remote.get(path);
			await this.opts.local.write(path, got.data, got.mtime);
			this.hashCache.forget(path);
			await this.setBase(base, path, got.hash ?? remoteHash ?? "");
		}

		counts.conflicts++;
		log({ path, action: "conflict", detail: `both sides changed; local copy kept as "${renamed}"` });
	}
}

function emptySummary(): SyncSummary {
	return { ok: true, entries: [], pushed: 0, pulled: 0, deletedLocal: 0, deletedRemote: 0, conflicts: 0, skipped: 0, errors: 0 };
}