// Note Keeper Sync — Obsidian plugin entry point. Wires the engine
// (src/engine.ts), the signed HTTP client (src/remote.ts) and the vault
// adapter (src/obsidian-fs.ts) into a Plugin with a settings tab, status
// bar item, ribbon icon, commands and a sync-log modal.

import { App, Notice, Platform, Plugin, PluginSettingTab, Setting, requestUrl } from "obsidian";
import { isExcluded, SyncEngine, type SyncLogEntry, type SyncSummary } from "./engine.ts";
import { ObsidianFS } from "./obsidian-fs.ts";
import { makeObsidianTransport, RemoteClient } from "./remote.ts";

interface NoteKeeperSyncSettings {
	serverUrl: string;
	deviceId: string;
	deviceSecret: string;
	deviceName: string;
	vaultName: string;
	syncIntervalSeconds: number; // 0 = manual only
	syncOnStartup: boolean;
	syncOnFileChange: boolean;
	excludedFolders: string[];
	/** Persisted three-way base map: vault-relative path -> last-agreed hash. */
	baseMap: Record<string, string>;
	lastManifestEtag: string;
	lastSyncAt: number;
}

const DEFAULT_SETTINGS: NoteKeeperSyncSettings = {
	serverUrl: "https://llm.tzekos.eu/nk-sync",
	deviceId: "",
	deviceSecret: "",
	deviceName: "",
	vaultName: "",
	syncIntervalSeconds: 20,
	syncOnStartup: true,
	syncOnFileChange: true,
	excludedFolders: [],
	baseMap: {},
	lastManifestEtag: "",
	lastSyncAt: 0
};

const FILE_CHANGE_DEBOUNCE_MS = 3000;
const MAX_LOG_ENTRIES = 100;

type SyncState = "not-connected" | "idle" | "syncing" | "error";

function defaultDeviceName(): string {
	// navigator.platform is deprecated but still the most reliable brief
	// device label across desktop/iOS/Android inside Obsidian's runtimes.
	const nav = (globalThis as any).navigator;
	if (Platform.isMobile) {
		return Platform.isIosApp ? "iPhone/iPad" : Platform.isAndroidApp ? "Android" : "Mobile";
	}
	return (nav && typeof nav.platform === "string" && nav.platform) || "Desktop";
}

export default class NoteKeeperSyncPlugin extends Plugin {
	settings: NoteKeeperSyncSettings = DEFAULT_SETTINGS;
	remote!: RemoteClient;
	engine!: SyncEngine;
	localFS!: ObsidianFS;

	private statusBarItem!: HTMLElement;
	private syncing = false;
	private allowMassDeleteOnce = false;
	private intervalHandle: number | null = null;
	private debounceHandle: number | null = null;
	private logEntries: SyncLogEntry[] = [];
	private lastError = "";

	async onload(): Promise<void> {
		await this.loadSettings();
		this.buildClients();

		this.statusBarItem = this.addStatusBarItem();
		this.statusBarItem.addClass("nk-sync-status");
		this.renderStatus();

		this.addRibbonIcon("refresh-cw", "Note Keeper Sync: sync now", () => {
			void this.runSync("manual");
		});

		this.addCommand({
			id: "note-keeper-sync-now",
			name: "Sync now",
			callback: () => void this.runSync("manual")
		});
		this.addCommand({
			id: "note-keeper-sync-show-log",
			name: "Show sync log",
			callback: () => new SyncLogModal(this.app, this.logEntries).open()
		});

		this.addSettingTab(new NoteKeeperSyncSettingTab(this.app, this));

		// Vault events reschedule a debounced sync; ignore paths excluded
		// from sync so internal/config churn does not cause needless work.
		const onVaultChange = (path: string) => {
			if (!this.settings.syncOnFileChange) return;
			if (isExcluded(path, this.app.vault.configDir, this.settings.excludedFolders)) return;
			this.scheduleDebouncedSync();
		};
		this.registerEvent(this.app.vault.on("create", (f) => onVaultChange(f.path)));
		this.registerEvent(this.app.vault.on("modify", (f) => onVaultChange(f.path)));
		this.registerEvent(this.app.vault.on("delete", (f) => onVaultChange(f.path)));
		this.registerEvent(this.app.vault.on("rename", (f) => onVaultChange(f.path)));

		this.applyIntervalSetting();

		if (this.settings.syncOnStartup && this.remote.hasCredentials()) {
			this.app.workspace.onLayoutReady(() => void this.runSync("startup"));
		}
	}

	onunload(): void {
		this.clearInterval();
		this.clearDebounce();
	}

	// ---- settings -----------------------------------------------------

	async loadSettings(): Promise<void> {
		const data = (await this.loadData()) as Partial<NoteKeeperSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
		if (!this.settings.deviceName) this.settings.deviceName = defaultDeviceName();
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private buildClients(): void {
		this.remote = new RemoteClient(this.settings.serverUrl, makeObsidianTransport(requestUrl));
		if (this.settings.deviceId && this.settings.deviceSecret) {
			this.remote.setCredentials(this.settings.deviceId, this.settings.deviceSecret);
		}
		this.localFS = new ObsidianFS(this.app.vault);
		this.engine = new SyncEngine({
			local: this.localFS,
			remote: this.remote,
			deviceName: this.settings.deviceName || defaultDeviceName(),
			configDir: this.app.vault.configDir,
			excludePrefixes: this.settings.excludedFolders,
			onBaseChange: async (path, hash) => {
				if (hash === null) delete this.settings.baseMap[path];
				else this.settings.baseMap[path] = hash;
				await this.saveSettings();
			}
		});
	}

	/** Rebuilds the clients after a settings change (server URL, excluded
	 * folders, device name) without discarding the persisted base map. The
	 * engine's hash cache is intentionally dropped: exclusion rules may have
	 * changed which paths matter. */
	rebuildClients(): void {
		this.buildClients();
	}

	// ---- scheduling -----------------------------------------------------

	applyIntervalSetting(): void {
		this.clearInterval();
		if (this.settings.syncIntervalSeconds > 0) {
			this.intervalHandle = window.setInterval(
				() => void this.runSync("interval"),
				this.settings.syncIntervalSeconds * 1000
			);
			this.registerInterval(this.intervalHandle);
		}
	}

	private clearInterval(): void {
		if (this.intervalHandle !== null) {
			window.clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
	}

	private scheduleDebouncedSync(): void {
		this.clearDebounce();
		this.debounceHandle = window.setTimeout(() => void this.runSync("file-change"), FILE_CHANGE_DEBOUNCE_MS);
		this.registerInterval(this.debounceHandle);
	}

	private clearDebounce(): void {
		if (this.debounceHandle !== null) {
			window.clearTimeout(this.debounceHandle);
			this.debounceHandle = null;
		}
	}

	// ---- pairing --------------------------------------------------------

	async connect(code: string): Promise<void> {
		const result = await this.remote.pair(code.trim(), {
			name: this.settings.deviceName || defaultDeviceName(),
			platform: Platform.isMobile ? (Platform.isIosApp ? "ios" : "android") : "desktop",
			app: "obsidian"
		});
		this.settings.deviceId = result.deviceId;
		this.settings.deviceSecret = result.secret;
		this.settings.vaultName = result.vault;
		await this.saveSettings();
		this.rebuildClients();
		this.setState("idle");
	}

	async disconnect(): Promise<void> {
		this.settings.deviceId = "";
		this.settings.deviceSecret = "";
		this.settings.vaultName = "";
		this.settings.baseMap = {};
		this.settings.lastManifestEtag = "";
		await this.saveSettings();
		this.rebuildClients();
		this.clearInterval();
		this.setState("not-connected");
	}

	async testConnection(): Promise<string> {
		const who = await this.remote.whoami();
		return `Connected as "${who.name}" to vault "${who.vault}"`;
	}

	// ---- sync -------------------------------------------------------------

	allowOneMassDeletion(): void {
		this.allowMassDeleteOnce = true;
		new Notice("Note Keeper Sync: the next sync run may delete more than half the vault.");
	}

	async runSync(reason: "manual" | "startup" | "interval" | "file-change"): Promise<void> {
		if (!this.remote.hasCredentials()) {
			this.setState("not-connected");
			return;
		}
		if (this.syncing) return; // mutex: never overlap runs; the next trigger will retry
		this.syncing = true;
		this.setState("syncing");
		try {
			if (reason === "interval" && this.settings.lastManifestEtag) {
				// Cheap poll first: skip the full local scan when the remote
				// manifest has not changed since our last successful pass.
				const check = await this.remote.manifest(this.settings.lastManifestEtag);
				if (check.notModified) {
					this.syncing = false;
					this.setState("idle");
					return;
				}
			}
			const allowMassDelete = this.allowMassDeleteOnce;
			this.allowMassDeleteOnce = false;
			const base = new Map(Object.entries(this.settings.baseMap));
			const result: SyncSummary = await this.engine.runOnce(base, { allowMassDelete });
			this.appendLog(result.entries);
			if (result.manifestVersion) {
				this.settings.lastManifestEtag = result.manifestVersion;
			}
			this.settings.lastSyncAt = Date.now();
			await this.saveSettings();

			if (result.aborted) {
				this.lastError = result.entries[0]?.detail ?? "sync aborted";
				this.setState("error");
				new Notice(`Note Keeper Sync: ${this.lastError}`, 20000);
				return;
			}
			if (result.conflicts > 0) {
				new Notice(
					`Note Keeper Sync: ${result.conflicts} conflict(s). Local copies were kept under new names; see "Show sync log".`,
					12000
				);
			}
			if (result.errors > 0) {
				this.lastError = `${result.errors} error(s) during sync; see "Show sync log"`;
				new Notice(`Note Keeper Sync: ${this.lastError}`, 12000);
				this.setState("error");
				return;
			}
			this.setState("idle");
		} catch (err) {
			this.lastError = (err as Error)?.message ?? String(err);
			this.setState("error");
			new Notice(`Note Keeper Sync failed: ${this.lastError}`, 12000);
		} finally {
			this.syncing = false;
		}
	}

	private appendLog(entries: SyncLogEntry[]): void {
		this.logEntries = [...this.logEntries, ...entries].slice(-MAX_LOG_ENTRIES);
	}

	// ---- status bar -------------------------------------------------------

	private syncState: SyncState = "not-connected";

	private setState(state: SyncState): void {
		this.syncState = state;
		this.renderStatus();
	}

	private renderStatus(): void {
		if (!this.statusBarItem) return;
		const label = (() => {
			switch (this.syncState) {
				case "not-connected":
					return "Note Keeper: not connected";
				case "syncing":
					return "Note Keeper: syncing…";
				case "error":
					return `Note Keeper: ⚠ ${this.lastError || "error"}`;
				case "idle":
				default: {
					const t = this.settings.lastSyncAt ? new Date(this.settings.lastSyncAt) : null;
					const time = t ? `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}` : "";
					return time ? `Note Keeper: ✓ ${time}` : "Note Keeper: ✓";
				}
			}
		})();
		this.statusBarItem.setText(label);
	}
}

// ---- settings tab -----------------------------------------------------------

class NoteKeeperSyncSettingTab extends PluginSettingTab {
	private pairingCode = "";

	constructor(
		app: App,
		private readonly plugin: NoteKeeperSyncPlugin
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.createEl("h2", { text: "Note Keeper Sync" });

		new Setting(containerEl)
			.setName("Server URL")
			.setDesc("The Note Keeper sync endpoint, e.g. https://llm.tzekos.eu/nk-sync")
			.addText((text) =>
				text
					.setPlaceholder(DEFAULT_SETTINGS.serverUrl)
					.setValue(this.plugin.settings.serverUrl)
					.onChange(async (value) => {
						this.plugin.settings.serverUrl = value.trim() || DEFAULT_SETTINGS.serverUrl;
						await this.plugin.saveSettings();
						this.plugin.rebuildClients();
					})
			);

		new Setting(containerEl)
			.setName("Device name")
			.setDesc("Shown in Note Keeper's device list and used to label conflict copies made on this device.")
			.addText((text) =>
				text
					.setPlaceholder(defaultDeviceName())
					.setValue(this.plugin.settings.deviceName)
					.onChange(async (value) => {
						this.plugin.settings.deviceName = value.trim();
						await this.plugin.saveSettings();
						this.plugin.rebuildClients();
					})
			);

		containerEl.createEl("h3", { text: "Connection" });

		if (this.plugin.remote.hasCredentials()) {
			new Setting(containerEl)
				.setName("Status")
				.setDesc(`Paired with vault "${this.plugin.settings.vaultName || "?"}" as device ${this.plugin.settings.deviceId}.`)
				.addButton((btn) =>
					btn.setButtonText("Test connection").onClick(async () => {
						try {
							const msg = await this.plugin.testConnection();
							new Notice(msg);
						} catch (err) {
							new Notice(`Test failed: ${(err as Error).message}`);
						}
					})
				)
				.addButton((btn) =>
					btn
						.setButtonText("Disconnect")
						.setWarning()
						.onClick(async () => {
							await this.plugin.disconnect();
							this.display();
						})
				);
		} else {
			new Setting(containerEl)
				.setName("Pairing code")
				.setDesc('In Note Keeper: Connect → Obsidian, then paste the 10-character code here.')
				.addText((text) =>
					text.setPlaceholder("XXXX-XXXX-XX").onChange((value) => {
						this.pairingCode = value;
					})
				)
				.addButton((btn) =>
					btn
						.setButtonText("Connect")
						.setCta()
						.onClick(async () => {
							if (!this.pairingCode.trim()) {
								new Notice("Enter the pairing code first.");
								return;
							}
							try {
								await this.plugin.connect(this.pairingCode);
								new Notice("Note Keeper Sync: paired successfully.");
								this.display();
							} catch (err) {
								new Notice(`Pairing failed: ${(err as Error).message}`);
							}
						})
				);
		}

		containerEl.createEl("h3", { text: "Sync behaviour" });

		new Setting(containerEl)
			.setName("Sync interval (seconds)")
			.setDesc("How often to poll the server. 0 disables automatic polling (manual sync only).")
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.syncIntervalSeconds))
					.onChange(async (value) => {
						const n = Math.max(0, Math.floor(Number(value) || 0));
						this.plugin.settings.syncIntervalSeconds = n;
						await this.plugin.saveSettings();
						this.plugin.applyIntervalSetting();
					})
			);

		new Setting(containerEl)
			.setName("Sync on startup")
			.setDesc("Run a sync shortly after Obsidian finishes loading this vault.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.syncOnStartup).onChange(async (v) => {
					this.plugin.settings.syncOnStartup = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Sync on file change")
			.setDesc("Run a sync 3 seconds after a local file create/edit/delete/rename settles.")
			.addToggle((t) =>
				t.setValue(this.plugin.settings.syncOnFileChange).onChange(async (v) => {
					this.plugin.settings.syncOnFileChange = v;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Excluded folders")
			.setDesc("One vault-relative folder path per line; these are never synced in either direction.")
			.addTextArea((t) =>
				t
					.setPlaceholder("Private\nScratch/Drafts")
					.setValue(this.plugin.settings.excludedFolders.join("\n"))
					.onChange(async (v) => {
						this.plugin.settings.excludedFolders = v
							.split("\n")
							.map((s) => s.trim())
							.filter((s) => s.length > 0);
						await this.plugin.saveSettings();
						this.plugin.rebuildClients();
					})
			);

		containerEl.createEl("h3", { text: "Actions" });

		new Setting(containerEl)
			.setName("Sync now")
			.setDesc("Run a sync pass immediately.")
			.addButton((btn) => btn.setButtonText("Sync now").setCta().onClick(() => void this.plugin.runSync("manual")));

		new Setting(containerEl)
			.setName("Show sync log")
			.setDesc("The last 100 sync operations (pushes, pulls, deletes, conflicts, errors).")
			.addButton((btn) =>
				btn.setButtonText("Show log").onClick(() => {
					new SyncLogModal(this.app, (this.plugin as any).logEntries ?? []).open();
				})
			);

		new Setting(containerEl)
			.setName("Allow one mass-deletion sync")
			.setDesc(
				"The deletion guard refuses to delete more than half the vault (and more than 10 files) in one pass. Click this, then Sync now, to allow it exactly once."
			)
			.addButton((btn) =>
				btn.setButtonText("Allow once").onClick(() => this.plugin.allowOneMassDeletion())
			);
	}
}

// ---- sync log modal ---------------------------------------------------------

import { Modal } from "obsidian";

class SyncLogModal extends Modal {
	constructor(
		app: App,
		private readonly entries: SyncLogEntry[]
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Note Keeper Sync — recent log" });
		if (this.entries.length === 0) {
			contentEl.createEl("p", { text: "No sync operations recorded yet." });
			return;
		}
		const table = contentEl.createEl("table", { cls: "nk-sync-log" });
		const head = table.createEl("tr");
		head.createEl("th", { text: "Time" });
		head.createEl("th", { text: "Action" });
		head.createEl("th", { text: "Path" });
		head.createEl("th", { text: "Detail" });
		for (const entry of [...this.entries].reverse()) {
			const row = table.createEl("tr");
			row.createEl("td", { text: new Date(entry.timestamp).toLocaleTimeString() });
			row.createEl("td", { text: entry.action, cls: `nk-sync-log-action nk-sync-log-${entry.action}` });
			row.createEl("td", { text: entry.path });
			row.createEl("td", { text: entry.detail ?? "" });
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}