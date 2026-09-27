// Manual end-to-end check against the live public endpoint (not part of npm test).
// Usage: node test/e2e-public.mts <PAIRING-CODE> [baseUrl]
import { RemoteClient, makeFetchTransport } from "../src/remote.ts";
const code = process.argv[2];
const base = process.argv[3] || "https://llm.tzekos.eu/nk-sync";
const c = new RemoteClient(base, makeFetchTransport(fetch));
const p = await c.pair(code, { name: "E2E test", platform: "linux", app: "e2e" });
console.log("paired", p.vault, p.protocol);
console.log("whoami", JSON.stringify(await c.whoami()));
const m = await c.manifest();
console.log("manifest files", m.files?.length ?? m);
const path = "E2E/Sync test é.md";
const data = new TextEncoder().encode("# Hello from the public sync API\n");
const put = await c.put(path, data, "", Date.now());
console.log("put", JSON.stringify(put));
const got = await c.get(path);
console.log("get", new TextDecoder().decode(got.data).trim());
const again = await c.put(path, data, "", Date.now());
console.log("stale put", JSON.stringify(again).slice(0, 80));
const del = await c.del(path, got.hash);
console.log("delete", JSON.stringify(del));
console.log("deviceId", p.deviceId);
