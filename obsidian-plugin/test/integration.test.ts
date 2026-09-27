// Integration test against the REAL Go notekeeperd binary: spawns it, pairs
// two devices through it, and drives the actual RemoteClient + SyncEngine
// against its real HTTP API. This is the only test file that touches
// node:child_process/node:fs — everything under src/ still runs unmodified
// in an Obsidian mobile context; only this test needs Node.
//
// Run with: npm test (this file is picked up by test/*.test.ts).
// Skips itself (with a clear message) when Go is unavailable, but on a
// normal dev machine it builds and runs for real — no mocks.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

import { RemoteClient, makeFetchTransport } from "../src/remote.ts";
import { SyncEngine } from "../src/engine.ts";
import { FakeLocalFS } from "./fakes.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const SERVER_DIR = join(REPO_ROOT, "server");
const REUSABLE_BIN = join(REPO_ROOT, "bin", "notekeeperd");

interface Daemon {
	proc: ChildProcessByStdio<null, Readable, Readable>;
	adminBase: string; // http://host:port (main NK_LISTEN)
	syncBase: string; // http://host:port/nk-sync (NK_SYNC_LISTEN + prefix)
	secret: string;
}

let daemon: Daemon | undefined;
let skipReason = "";

/** Locates a usable notekeeperd binary: reuses server/../bin/notekeeperd
 * when present, otherwise builds one into a temp dir with "go build". */
function resolveBinary(): string | null {
	if (existsSync(REUSABLE_BIN)) return REUSABLE_BIN;
	const goCheck = spawnSync("go", ["version"], { encoding: "utf8" });
	if (goCheck.status !== 0) return null;
	const outDir = mkdtempSync(join(tmpdir(), "nk-plugin-test-"));
	const outBin = join(outDir, "notekeeperd");
	const build = spawnSync("go", ["build", "-o", outBin, "./cmd/notekeeperd"], {
		cwd: SERVER_DIR,
		encoding: "utf8"
	});
	if (build.status !== 0) {
		console.error("go build failed:\n" + build.stdout + build.stderr);
		return null;
	}
	return outBin;
}

/** Spawns notekeeperd and waits for its two "NK_..._LISTEN" stdout lines. */
async function startDaemon(): Promise<Daemon> {
	const bin = resolveBinary();
	if (!bin) throw new Error("no notekeeperd binary available and could not build one (Go missing?)");

	const vaultDir = mkdtempSync(join(tmpdir(), "nk-plugin-vault-"));
	const stateDir = mkdtempSync(join(tmpdir(), "nk-plugin-state-"));
	const secret = randomBytes(16).toString("hex"); // 32 hex chars, well above the 16-char minimum

	const proc = spawn(bin, ["-addr", "127.0.0.1:0"], {
		env: {
			...process.env,
			NK_SECRET: secret,
			NK_VAULT: vaultDir,
			NK_STATE: stateDir,
			NK_SYNC_ADDR: "127.0.0.1:0"
		},
		stdio: ["ignore", "pipe", "pipe"]
	});

	let syncListen = "";
	let mainListen = "";
	let stderrTail = "";
	proc.stderr.on("data", (d) => {
		stderrTail = (stderrTail + d.toString()).slice(-4000);
	});

	await new Promise<void>((resolve, reject) => {
		let buf = "";
		const timeout = setTimeout(() => reject(new Error("daemon did not print its listen lines in time:\n" + stderrTail)), 15000);
		proc.stdout.on("data", (chunk: Buffer) => {
			buf += chunk.toString();
			let idx: number;
			while ((idx = buf.indexOf("\n")) !== -1) {
				const line = buf.slice(0, idx).trim();
				buf = buf.slice(idx + 1);
				if (line.startsWith("NK_SYNC_LISTEN ")) syncListen = line.slice("NK_SYNC_LISTEN ".length).trim();
				if (line.startsWith("NK_LISTEN ")) mainListen = line.slice("NK_LISTEN ".length).trim();
				if (syncListen && mainListen) {
					clearTimeout(timeout);
					resolve();
				}
			}
		});
		proc.on("exit", (code) => {
			clearTimeout(timeout);
			reject(new Error(`daemon exited early with code ${code}:\n${stderrTail}`));
		});
	});

	return {
		proc,
		adminBase: "http://" + mainListen,
		syncBase: "http://" + syncListen + "/nk-sync",
		secret
	};
}

/** Gets a one-time pairing code from the LOCAL admin API (X-NK-Secret). */
async function getPairingCode(d: Daemon): Promise<string> {
	const res = await fetch(d.adminBase + "/sync/pair", {
		method: "POST",
		headers: { "X-NK-Secret": d.secret }
	});
	assert.equal(res.status, 200, "admin pairing endpoint should accept the shared secret");
	const body = (await res.json()) as { code: string };
	assert.ok(body.code, "pairing code should be present");
	return body.code;
}

async function pairClient(d: Daemon, name: string): Promise<RemoteClient> {
	const client = new RemoteClient(d.syncBase, makeFetchTransport(fetch));
	const code = await getPairingCode(d);
	await client.pair(code, { name, platform: "test", app: "node-test" });
	assert.ok(client.hasCredentials());
	return client;
}

function textOf(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function bytesOf(text: string): Uint8Array {
	return new TextEncoder().encode(text);
}

// ---- lifecycle ----------------------------------------------------------------

before(async () => {
	try {
		daemon = await startDaemon();
	} catch (err) {
		skipReason = (err as Error).message;
		console.warn("Skipping integration tests: " + skipReason);
	}
});

after(async () => {
	if (daemon) {
		daemon.proc.kill("SIGTERM");
		await new Promise<void>((resolve) => {
			daemon!.proc.once("exit", () => resolve());
			setTimeout(resolve, 3000);
		});
	}
});

function requireDaemon(): Daemon {
	if (!daemon) throw new Error("daemon not started: " + skipReason);
	return daemon;
}

// ---- tests --------------------------------------------------------------------

test("pairing works and whoami reports the paired device", async (t) => {
	if (!daemon) { t.skip(skipReason || "daemon unavailable"); return; }
	const d = requireDaemon();
	const client = await pairClient(d, "IntegrationDevice");
	const who = await client.whoami();
	assert.equal(who.name, "IntegrationDevice");
});

test("initial two-way sync: server has files, local has files, both converge", async (t) => {
	if (!daemon) { t.skip(skipReason || "daemon unavailable"); return; }
	const d = requireDaemon();
	const client = await pairClient(d, "InitialSyncDevice");
	// Seed the "server already has this" side directly through the API.
	await client.put("T1/ServerOnly.md", bytesOf("from server"), "", Date.now());
	await client.put("T1/Shared.md", bytesOf("shared content"), "", Date.now());

	const local = FakeLocalFS.fromEntries({
		"T1/LocalOnly.md": { text: "from local", mtime: Date.now() },
		"T1/Shared.md": { text: "shared content", mtime: Date.now() } // identical: should be a no-op
	});
	const engine = new SyncEngine({ local, remote: client, deviceName: "InitialSyncDevice" });
	const base = new Map<string, string>();
	const result = await engine.runOnce(base);

	assert.equal(result.ok, true);
	assert.equal(textOf(local.files.get("T1/ServerOnly.md")!.data), "from server");
	assert.equal(local.files.has("T1/LocalOnly.md"), true);
	const remoteManifest = await client.manifest();
	assert.ok(!remoteManifest.notModified);
	const paths = remoteManifest.files.map((f) => f.path);
	assert.ok(paths.includes("T1/LocalOnly.md"), "local-only file should have been pushed");
	assert.ok(paths.includes("T1/ServerOnly.md"));
	assert.ok(paths.includes("T1/Shared.md"));
});

test("edits on both sides, then delete propagation both ways", async (t) => {
	if (!daemon) { t.skip(skipReason || "daemon unavailable"); return; }
	const d = requireDaemon();
	const client = await pairClient(d, "EditDevice");
	const local = FakeLocalFS.fromEntries({});
	const engine = new SyncEngine({ local, remote: client, deviceName: "EditDevice" });
	const base = new Map<string, string>();

	// First sync creates T2/A.md and T2/B.md from local.
	local.files.set("T2/A.md", { data: bytesOf("a1"), mtime: 1000 });
	local.files.set("T2/B.md", { data: bytesOf("b1"), mtime: 1000 });
	await engine.runOnce(base);

	// Edit A on the "remote" side (simulating another device) and B locally.
	const aHash = base.get("T2/A.md")!;
	await client.put("T2/A.md", bytesOf("a2-remote"), aHash, Date.now());
	local.files.set("T2/B.md", { data: bytesOf("b2-local"), mtime: 2000 });

	const result = await engine.runOnce(base);
	assert.equal(result.ok, true);
	assert.equal(textOf(local.files.get("T2/A.md")!.data), "a2-remote", "remote edit should be pulled");
	const remoteB = await client.get("T2/B.md");
	assert.equal(textOf(remoteB.data), "b2-local", "local edit should be pushed");

	// Now delete A locally and delete B on the remote; both propagate.
	local.files.delete("T2/A.md");
	local.removed.push("T2/A.md");
	const bHash = base.get("T2/B.md")!;
	const del = await client.del("T2/B.md", bHash);
	assert.equal(del.ok, true);

	const result2 = await engine.runOnce(base);
	assert.equal(result2.ok, true);
	assert.equal(result2.deletedRemote, 1, "A's local delete should propagate to the server");
	assert.equal(result2.deletedLocal, 1, "B's remote delete should propagate to local");
	assert.equal(local.files.has("T2/B.md"), false);
	const finalManifest = await client.manifest();
	assert.ok(!finalManifest.notModified);
	assert.ok(!finalManifest.files.some((f) => f.path === "T2/A.md"));
});

test("both sides edit the same file: conflict copy created and pushed, original holds remote content", async (t) => {
	if (!daemon) { t.skip(skipReason || "daemon unavailable"); return; }
	const d = requireDaemon();
	const client = await pairClient(d, "ConflictDevice");
	const local = FakeLocalFS.fromEntries({});
	const engine = new SyncEngine({ local, remote: client, deviceName: "ConflictDevice", now: () => Date.UTC(2024, 5, 15, 9, 0) });
	const base = new Map<string, string>();

	local.files.set("T3/Doc.md", { data: bytesOf("v1"), mtime: 1000 });
	await engine.runOnce(base);

	const h = base.get("T3/Doc.md")!;
	await client.put("T3/Doc.md", bytesOf("remote-edit"), h, Date.now());
	local.files.set("T3/Doc.md", { data: bytesOf("local-edit"), mtime: 2000 });

	const result = await engine.runOnce(base);
	assert.equal(result.conflicts, 1);
	assert.equal(textOf(local.files.get("T3/Doc.md")!.data), "remote-edit");
	const conflictPath = [...local.files.keys()].find((p) => p.startsWith("T3/Doc (conflict"));
	assert.ok(conflictPath);
	assert.equal(textOf(local.files.get(conflictPath!)!.data), "local-edit");
	const remoteConflict = await client.get(conflictPath!);
	assert.equal(textOf(remoteConflict.data), "local-edit", "conflict copy must also land on the server");
});

test("Greek and spaced filenames, and a binary file, round-trip byte-for-byte", async (t) => {
	if (!daemon) { t.skip(skipReason || "daemon unavailable"); return; }
	const d = requireDaemon();
	const client = await pairClient(d, "UnicodeDevice");
	const local = FakeLocalFS.fromEntries({});
	const engine = new SyncEngine({ local, remote: client, deviceName: "UnicodeDevice" });
	const base = new Map<string, string>();

	const greekPath = "T4/Σημειώσεις με κενά.md";
	const binPath = "T4/image.bin";
	const binBytes = new Uint8Array(256);
	for (let i = 0; i < 256; i++) binBytes[i] = i;

	local.files.set(greekPath, { data: bytesOf("Ελληνικό περιεχόμενο"), mtime: 1000 });
	local.files.set(binPath, { data: binBytes, mtime: 1000 });
	const result = await engine.runOnce(base);
	assert.equal(result.ok, true);
	assert.equal(result.pushed, 2);

	const gotText = await client.get(greekPath);
	assert.equal(textOf(gotText.data), "Ελληνικό περιεχόμενο");
	const gotBin = await client.get(binPath);
	assert.deepEqual([...gotBin.data], [...binBytes]);
});

test("encrypted folder rule: plaintext refused, envelope accepted", async (t) => {
	if (!daemon) { t.skip(skipReason || "daemon unavailable"); return; }
	const d = requireDaemon();
	const client = await pairClient(d, "EncryptedFolderDevice");
	const local = FakeLocalFS.fromEntries({});
	const engine = new SyncEngine({ local, remote: client, deviceName: "EncryptedFolderDevice" });
	const base = new Map<string, string>();

	// The lock marker (hidden, but the one hidden name that syncs) locks the folder.
	local.files.set("T5Secret/.nk-lock.json", { data: bytesOf('{"v":1,"salt":"AAAA"}'), mtime: 1000 });
	const r1 = await engine.runOnce(base);
	assert.equal(r1.pushed, 1);

	// A plain markdown note pushed into that folder is refused (423).
	local.files.set("T5Secret/plain.md", { data: bytesOf("# plaintext"), mtime: 2000 });
	const r2 = await engine.runOnce(base);
	assert.equal(r2.errors, 1);
	assert.equal(r2.entries.find((e) => e.path === "T5Secret/plain.md")?.detail, "encrypted folder refused plaintext");
	assert.equal(base.has("T5Secret/plain.md"), false);

	// An encrypted envelope is accepted.
	local.files.delete("T5Secret/plain.md");
	const envelope = "---\nnk-encrypted: v1\n---\n```nk-cipher\nQUJD\n```\n";
	local.files.set("T5Secret/enc.md", { data: bytesOf(envelope), mtime: 3000 });
	const r3 = await engine.runOnce(base);
	assert.equal(r3.pushed, 1);
	assert.equal(r3.errors, 0);
	const onServer = await client.get("T5Secret/enc.md");
	assert.equal(textOf(onServer.data), envelope);
});

test("two independent clients converge through the server", async (t) => {
	if (!daemon) { t.skip(skipReason || "daemon unavailable"); return; }
	const d = requireDaemon();
	const clientA = await pairClient(d, "DeviceA");
	const clientB = await pairClient(d, "DeviceB");
	const localA = FakeLocalFS.fromEntries({});
	const localB = FakeLocalFS.fromEntries({});
	const engineA = new SyncEngine({ local: localA, remote: clientA, deviceName: "DeviceA" });
	const engineB = new SyncEngine({ local: localB, remote: clientB, deviceName: "DeviceB" });
	const baseA = new Map<string, string>();
	const baseB = new Map<string, string>();

	// A creates a file and syncs; B has not synced yet.
	localA.files.set("T6/Convergence.md", { data: bytesOf("from A"), mtime: 1000 });
	await engineA.runOnce(baseA);

	// B syncs: pulls A's file.
	await engineB.runOnce(baseB);
	assert.equal(textOf(localB.files.get("T6/Convergence.md")!.data), "from A");

	// B edits and syncs; A syncs and should pull B's edit.
	localB.files.set("T6/Convergence.md", { data: bytesOf("from B, edited"), mtime: 2000 });
	await engineB.runOnce(baseB);
	await engineA.runOnce(baseA);
	assert.equal(textOf(localA.files.get("T6/Convergence.md")!.data), "from B, edited");

	// Both bases now agree with the server's hash for this path.
	const manifest = await clientA.manifest();
	const serverHash = manifest.notModified ? undefined : manifest.files.find((f) => f.path === "T6/Convergence.md")?.hash;
	assert.equal(baseA.get("T6/Convergence.md"), serverHash);
	assert.equal(baseB.get("T6/Convergence.md"), serverHash);
});