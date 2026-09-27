// LocalFS implementation over Obsidian's app.vault.adapter. This is the only
// module that touches the "obsidian" module directly for filesystem access,
// so the engine and its tests stay Obsidian-free. adapter.list/stat/read/
// write are the mobile-safe primitives (no Node fs, works on iOS/Android).

import type { DataAdapter, TAbstractFile, Vault } from "obsidian";
import { TFile as TFileClass, normalizePath } from "obsidian";
import type { LocalFS, LocalFileInfo } from "./engine.ts";

/** Basename of a lock marker that must sync even though it is hidden. */
const LOCK_MARKER = ".nk-lock.json";

/** Recursively lists every regular file under the vault root, including
 * hidden marker files (".nk-lock.json") that the adapter itself does not
 * hide, but excluding any other dot-prefixed file or folder — the caller
 * (SyncEngine) applies the full exclusion policy; this only guarantees the
 * marker is not silently dropped by a naive "skip all dotfiles" listing. */
export class ObsidianFS implements LocalFS {
	constructor(
		private readonly vault: Vault,
		private readonly adapter: DataAdapter = vault.adapter
	) {}

	async list(): Promise<LocalFileInfo[]> {
		const out: LocalFileInfo[] = [];
		await this.walk("", out);
		return out;
	}

	private async walk(dir: string, out: LocalFileInfo[]): Promise<void> {
		const listing = await this.adapter.list(dir);
		for (const filePath of listing.files) {
			const name = basename(filePath);
			// The adapter's own listing already excludes ".trash" and some
			// platform noise, but not all hidden files; only surface the
			// lock marker among dotfiles, everything else is filtered by
			// SyncEngine's isExcluded() using the full path.
			if (name.startsWith(".") && name !== LOCK_MARKER) continue;
			const stat = await this.adapter.stat(filePath);
			if (!stat || stat.type !== "file") continue;
			out.push({ path: toVaultPath(filePath), size: stat.size, mtime: stat.mtime });
		}
		for (const folderPath of listing.folders) {
			const name = basename(folderPath);
			if (name.startsWith(".")) continue; // .obsidian, .trash, .git, ...
			await this.walk(folderPath, out);
		}
	}

	async read(path: string): Promise<Uint8Array> {
		const buf = await this.adapter.readBinary(normalizePath(path));
		return new Uint8Array(buf);
	}

	async write(path: string, data: Uint8Array, mtime: number): Promise<void> {
		const norm = normalizePath(path);
		await this.mkdirParents(norm);
		await this.adapter.writeBinary(norm, toArrayBuffer(data), { mtime });
	}

	async remove(path: string): Promise<void> {
		const norm = normalizePath(path);
		const af: TAbstractFile | null = this.vault.getAbstractFileByPath(norm);
		if (af && af instanceof TFileClass) {
			// system=false: goes to the Obsidian trash (.trash/), matching
			// the server's own delete-to-.trash behaviour, and matching
			// what the sync docs call "the Obsidian trash".
			await this.vault.trash(af, false);
			return;
		}
		// Not tracked by the Vault index (e.g. a hidden lock marker): fall
		// back to the adapter's own trash, still non-destructive.
		if (await this.adapter.exists(norm)) {
			await this.adapter.trashLocal(norm);
		}
	}

	async rename(from: string, to: string): Promise<void> {
		const nf = normalizePath(from);
		const nt = normalizePath(to);
		await this.mkdirParents(nt);
		const af = this.vault.getAbstractFileByPath(nf);
		if (af && af instanceof TFileClass) {
			await this.vault.rename(af, nt);
			return;
		}
		await this.adapter.rename(nf, nt);
	}

	async exists(path: string): Promise<boolean> {
		return this.adapter.exists(normalizePath(path));
	}

	private async mkdirParents(path: string): Promise<void> {
		const dir = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
		if (!dir) return;
		if (await this.adapter.exists(dir)) return;
		await this.adapter.mkdir(dir);
	}
}

function basename(p: string): string {
	const i = p.lastIndexOf("/");
	return i === -1 ? p : p.slice(i + 1);
}

/** Adapter paths are already vault-relative and "/"-separated on every
 * platform Obsidian supports; this exists purely as a documented seam in
 * case that assumption ever needs revisiting. */
function toVaultPath(adapterPath: string): string {
	return adapterPath;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}