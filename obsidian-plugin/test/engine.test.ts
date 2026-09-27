// Unit tests for the three-way sync decision table (docs/SYNC-PROTOCOL.md),
// exercised entirely with in-memory fakes (no filesystem, no network).
// Run with: npm test (type-checks, then node --test).

import { test } from "node:test";
import assert from "node:assert/strict";
import { SyncEngine, isExcluded, type SyncSummary } from "../src/engine.ts";
import { FakeLocalFS, FakeRemote } from "./fakes.ts";
import { sha256Hex } from "../src/crypto.ts";

const T0 = Date.UTC(2024, 4, 1, 10, 30); // 2024-05-01 10:30 UTC, fixed clock for deterministic conflict names

function mkEngine(local: FakeLocalFS, remote: FakeRemote, opts: Record<string, unknown> = {}): SyncEngine {
	return new SyncEngine({
		local,
		remote,
		deviceName: "TestDevice",
		configDir: ".obsidian",
		excludePrefixes: [],
		now: () => T0,
		...opts
	} as ConstructorParameters<typeof SyncEngine>[0]);
}

async function hashText(text: string): Promise<string> {
	return sha256Hex(new TextEncoder().encode(text));
}

// ---- Row 1: unchanged --------------------------------------------------------

test("unchanged: identical content on both sides is a no-op and records base", async () => {
	const local = FakeLocalFS.fromEntries({ "A.md": { text: "hello", mtime: 1000 } });
	const remote = await FakeRemote.fromEntries({ "A.md": { text: "hello", mtime: 1000 } });
	const engine = mkEngine(local, remote);
	const base = new Map<string, string>(); // no prior base: still L===R, still a no-op
	const result = await engine.runOnce(base);
	assert.equal(result.pushed, 0);
	assert.equal(result.pulled, 0);
	assert.equal(result.conflicts, 0);
	assert.equal(base.get("A.md"), await hashText("hello"));
	assert.equal(local.files.size, 1);
	assert.equal(remote.files.size, 1);
});

// ---- Row 2: remote changed -> pull -------------------------------------------

test("pull: remote edited, local unchanged since base", async () => {
	const h = await hashText("v1");
	const local = FakeLocalFS.fromEntries({ "A.md": { text: "v1", mtime: 1000 } });
	const remote = await FakeRemote.fromEntries({ "A.md": { text: "v2", mtime: 2000 } });
	const engine = mkEngine(local, remote);
	const base = new Map([["A.md", h]]);
	const result = await engine.runOnce(base);
	assert.equal(result.pulled, 1);
	assert.equal(new TextDecoder().decode(local.files.get("A.md")!.data), "v2");
	assert.equal(local.files.get("A.md")!.mtime, 2000);
	assert.equal(base.get("A.md"), await hashText("v2"));
});

test("pull: remote deleted, local unchanged since base -> local delete", async () => {
	const h = await hashText("v1");
	const local = FakeLocalFS.fromEntries({ "A.md": { text: "v1", mtime: 1000 } });
	const remote = new FakeRemote(); // remote no longer has it
	const engine = mkEngine(local, remote);
	const base = new Map([["A.md", h]]);
	const result = await engine.runOnce(base);
	assert.equal(result.deletedLocal, 1);
	assert.equal(local.files.has("A.md"), false);
	assert.equal(base.has("A.md"), false);
});

// ---- Row 3: local changed -> push --------------------------------------------

test("push: local edited, remote unchanged since base", async () => {
	const h = await hashText("v1");
	const local = FakeLocalFS.fromEntries({ "A.md": { text: "v2", mtime: 2000 } });
	const remote = await FakeRemote.fromEntries({ "A.md": { text: "v1", mtime: 1000 } });
	const engine = mkEngine(local, remote);
	const base = new Map([["A.md", h]]);
	const result = await engine.runOnce(base);
	assert.equal(result.pushed, 1);
	assert.equal(new TextDecoder().decode(remote.files.get("A.md")!.data), "v2");
	assert.equal(base.get("A.md"), await hashText("v2"));
});

test("push: local deleted, remote unchanged since base -> remote delete", async () => {
	const h = await hashText("v1");
	const local = new FakeLocalFS();
	const remote = await FakeRemote.fromEntries({ "A.md": { text: "v1", mtime: 1000 } });
	const engine = mkEngine(local, remote);
	const base = new Map([["A.md", h]]);
	const result = await engine.runOnce(base);
	assert.equal(result.deletedRemote, 1);
	assert.equal(remote.files.has("A.md"), false);
	assert.equal(base.has("A.md"), false);
});

// ---- Row 4 & 5: delete vs edit ------------------------------------------------

test("local delete vs remote edit: pull wins, edit is never lost", async () => {
	const h = await hashText("v1");
	const local = new FakeLocalFS(); // locally deleted
	const remote = await FakeRemote.fromEntries({ "A.md": { text: "v2-edited", mtime: 2000 } }); // edited remotely
	const engine = mkEngine(local, remote);
	const base = new Map([["A.md", h]]);
	const result = await engine.runOnce(base);
	assert.equal(result.pulled, 1);
	assert.equal(new TextDecoder().decode(local.files.get("A.md")!.data), "v2-edited");
	assert.equal(base.get("A.md"), await hashText("v2-edited"));
});

test("remote delete vs local edit: push as create, edit is never lost", async () => {
	const h = await hashText("v1");
	const local = FakeLocalFS.fromEntries({ "A.md": { text: "v2-edited", mtime: 2000 } }); // edited locally
	const remote = new FakeRemote(); // deleted remotely
	const engine = mkEngine(local, remote);
	const base = new Map([["A.md", h]]);
	const result = await engine.runOnce(base);
	assert.equal(result.pushed, 1);
	assert.equal(new TextDecoder().decode(remote.files.get("A.md")!.data), "v2-edited");
	assert.equal(base.get("A.md"), await hashText("v2-edited"));
});

// ---- Row 6: both modified -> conflict copy -----------------------------------

test("both modified: conflict copy is created, pushed, and remote is pulled into the original path", async () => {
	const h = await hashText("base-content");
	const local = FakeLocalFS.fromEntries({ "Notes/A.md": { text: "local-edit", mtime: 3000 } });
	const remote = await FakeRemote.fromEntries({ "Notes/A.md": { text: "remote-edit", mtime: 4000 } });
	const engine = mkEngine(local, remote);
	const base = new Map([["Notes/A.md", h]]);
	const result = await engine.runOnce(base);
	assert.equal(result.conflicts, 1);
	// Original path now holds the remote content.
	assert.equal(new TextDecoder().decode(local.files.get("Notes/A.md")!.data), "remote-edit");
	// A conflict copy exists with the expected naming pattern and holds the local content.
	const conflictPath = [...local.files.keys()].find((p) => p !== "Notes/A.md" && p.startsWith("Notes/A ("));
	assert.ok(conflictPath, "expected a conflict copy to exist");
	assert.match(conflictPath!, /^Notes\/A \(conflict TestDevice \d{4}-\d{2}-\d{2} \d{4}\)\.md$/);
	assert.equal(new TextDecoder().decode(local.files.get(conflictPath!)!.data), "local-edit");
	// The conflict copy was also pushed to the remote under the same name.
	assert.ok(remote.files.has(conflictPath!), "conflict copy should be pushed to remote");
	assert.equal(new TextDecoder().decode(remote.files.get(conflictPath!)!.data), "local-edit");
});

// ---- First sync (no base map yet) --------------------------------------------

test("first sync, identical content at a path: no base yet, but L===R is still a no-op", async () => {
	const local = FakeLocalFS.fromEntries({ "A.md": { text: "same", mtime: 1000 } });
	const remote = await FakeRemote.fromEntries({ "A.md": { text: "same", mtime: 900 } });
	const engine = mkEngine(local, remote);
	const base = new Map<string, string>();
	const result = await engine.runOnce(base);
	assert.equal(result.pushed, 0);
	assert.equal(result.pulled, 0);
	assert.equal(result.conflicts, 0);
	assert.equal(base.get("A.md"), await hashText("same"));
});

test("first sync, different content at the same path: treated as a conflict", async () => {
	const local = FakeLocalFS.fromEntries({ "A.md": { text: "local-version", mtime: 1000 } });
	const remote = await FakeRemote.fromEntries({ "A.md": { text: "remote-version", mtime: 900 } });
	const engine = mkEngine(local, remote);
	const base = new Map<string, string>();
	const result = await engine.runOnce(base);
	assert.equal(result.conflicts, 1);
	assert.equal(new TextDecoder().decode(local.files.get("A.md")!.data), "remote-version");
});

// ---- 409 retry and 423 locked --------------------------------------------------

test("409 on push: the file is skipped this run and retried next run (base not advanced)", async () => {
	const h = await hashText("v1");
	const local = FakeLocalFS.fromEntries({ "A.md": { text: "v2", mtime: 2000 } });
	const remote = await FakeRemote.fromEntries({ "A.md": { text: "v1", mtime: 1000 } });
	remote.forceConflictOnce.add("A.md");
	const engine = mkEngine(local, remote);
	const base = new Map([["A.md", h]]);
	const result = await engine.runOnce(base);
	assert.equal(result.pushed, 0);
	assert.equal(result.errors, 1);
	assert.match(result.entries[0].detail ?? "", /will retry/);
	assert.equal(base.get("A.md"), h, "base must not advance on a conflicting push");
	// Retrying (no forced conflict this time) now succeeds.
	const result2 = await engine.runOnce(base);
	assert.equal(result2.pushed, 1);
});

test("423 on push: reported as an encrypted folder refusing plaintext", async () => {
	const local = FakeLocalFS.fromEntries({ "Secret/plain.md": { text: "plaintext", mtime: 1000 } });
	const remote = new FakeRemote();
	remote.lockedPaths.add("Secret/plain.md");
	const engine = mkEngine(local, remote);
	const base = new Map<string, string>();
	const result = await engine.runOnce(base);
	assert.equal(result.pushed, 0);
	assert.equal(result.errors, 1);
	assert.equal(result.entries[0].detail, "encrypted folder refused plaintext");
	assert.equal(base.has("Secret/plain.md"), false);
});

// ---- Deletion guard -----------------------------------------------------------

test("deletion guard: aborts a sync that would delete more than half the vault (and >10 files)", async () => {
	const localEntries: Record<string, { text: string; mtime: number }> = {};
	const remoteEntries: Record<string, { text: string; mtime: number }> = {};
	const base = new Map<string, string>();
	// 20 files existed on both sides; local has lost all of them (e.g. a
	// botched folder move) while remote still has them all.
	for (let i = 0; i < 20; i++) {
		const text = `content ${i}`;
		remoteEntries[`F${i}.md`] = { text, mtime: 1000 };
		base.set(`F${i}.md`, await hashText(text));
	}
	const local = FakeLocalFS.fromEntries(localEntries);
	const remote = await FakeRemote.fromEntries(remoteEntries);
	const engine = mkEngine(local, remote);
	const result = await engine.runOnce(base);
	assert.equal(result.ok, false);
	assert.equal(result.aborted?.reason, "mass-delete");
	assert.equal(result.aborted?.deletions, 20);
	assert.equal(local.files.size, 0, "no files should have been touched");
	assert.equal(base.size, 20, "base map must be untouched by an aborted run");

	// With the one-shot override, the same run proceeds: local already lost
	// these 20 files, so the guarded action is propagating that deletion to
	// the remote (not pulling — local really did delete them).
	const result2 = await engine.runOnce(base, { allowMassDelete: true });
	assert.equal(result2.ok, true);
	assert.equal(result2.deletedRemote, 20);
	assert.equal(remote.files.size, 0);
	assert.equal(base.size, 0);
});

test("deletion guard does not trip for a small vault (<=10 files)", async () => {
	const remoteEntries: Record<string, { text: string; mtime: number }> = {};
	const base = new Map<string, string>();
	for (let i = 0; i < 5; i++) {
		const text = `content ${i}`;
		remoteEntries[`F${i}.md`] = { text, mtime: 1000 };
		base.set(`F${i}.md`, await hashText(text));
	}
	const local = new FakeLocalFS(); // all 5 gone locally
	const remote = await FakeRemote.fromEntries(remoteEntries);
	const engine = mkEngine(local, remote);
	const result = await engine.runOnce(base);
	assert.equal(result.ok, true);
	assert.equal(result.deletedRemote, 5);
});

// ---- Exclusions -----------------------------------------------------------------

test("isExcluded: hidden segments are excluded except the .nk-lock.json marker", () => {
	assert.equal(isExcluded(".obsidian/app.json", ".obsidian", []), true);
	assert.equal(isExcluded("Notes/.hidden.md", ".obsidian", []), true);
	assert.equal(isExcluded("Secret/.nk-lock.json", ".obsidian", []), false);
	assert.equal(isExcluded(".nk-lock.json", ".obsidian", []), false);
	assert.equal(isExcluded("Notes/A.md", ".obsidian", []), false);
});

test("isExcluded: the config dir and user exclude prefixes are excluded outright", () => {
	assert.equal(isExcluded(".obsidian/plugins/foo/main.js", ".obsidian", []), true);
	assert.equal(isExcluded("Private/secret.md", ".obsidian", ["Private"]), true);
	assert.equal(isExcluded("Private2/note.md", ".obsidian", ["Private"]), false);
	assert.equal(isExcluded("Public/note.md", ".obsidian", ["Private"]), false);
});

test("engine: excluded paths are never synced, and a lock marker in a synced folder is", async () => {
	const local = FakeLocalFS.fromEntries({
		"Notes/A.md": { text: "hi", mtime: 1000 },
		".obsidian/app.json": { text: "{}", mtime: 1000 },
		"Private/secret.md": { text: "shh", mtime: 1000 },
		"Secret/.nk-lock.json": { text: '{"v":1}', mtime: 1000 }
	});
	const remote = new FakeRemote();
	const engine = mkEngine(local, remote, { excludePrefixes: ["Private"] });
	const base = new Map<string, string>();
	const result: SyncSummary = await engine.runOnce(base);
	assert.equal(result.pushed, 2, "Notes/A.md and the lock marker should push");
	assert.ok(remote.files.has("Notes/A.md"));
	assert.ok(remote.files.has("Secret/.nk-lock.json"));
	assert.ok(!remote.files.has(".obsidian/app.json"));
	assert.ok(!remote.files.has("Private/secret.md"));
});