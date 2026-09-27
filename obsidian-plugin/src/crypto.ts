// Web Crypto helpers used by the Note Keeper Sync plugin. Works unmodified
// on Obsidian desktop and mobile: only globalThis.crypto.subtle is used, no
// Node "crypto" module, so the same code runs on iOS/Android/Electron.
// See docs/SYNC-PROTOCOL.md for the exact signing scheme this implements.

/** Returns the WebCrypto SubtleCrypto implementation, throwing a clear error
 * when it is unavailable (should never happen inside Obsidian, but keeps
 * failures legible instead of a cryptic "subtle is undefined"). */
function subtle(): SubtleCrypto {
	const c = (globalThis as any).crypto as Crypto | undefined;
	if (!c || !c.subtle) {
		throw new Error("Web Crypto (crypto.subtle) is not available in this runtime");
	}
	return c.subtle;
}

function textToBytes(s: string): Uint8Array {
	return new TextEncoder().encode(s);
}

function bytesToHex(bytes: ArrayBuffer | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let out = "";
	for (let i = 0; i < arr.length; i++) {
		out += arr[i].toString(16).padStart(2, "0");
	}
	return out;
}

/** Standard base64url (RFC 4648 §5), no padding — matches Go's
 * base64.RawURLEncoding used by the server for secrets and signatures. */
function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
	const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
	let binary = "";
	for (let i = 0; i < arr.length; i++) {
		binary += String.fromCharCode(arr[i]);
	}
	// btoa is available in both Electron (browser context) and Obsidian
	// mobile's WebView; both are browser-like runtimes, not Node.
	const b64 = btoa(binary);
	return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decodes standard or base64url text (with or without padding) to bytes. */
export function base64UrlToBytes(s: string): Uint8Array {
	let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
	while (b64.length % 4 !== 0) b64 += "=";
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}

/** Hex-encoded SHA-256 of a body, matching the server's devsync.BodySHA. */
export async function sha256Hex(data: Uint8Array | string): Promise<string> {
	const bytes = typeof data === "string" ? textToBytes(data) : data;
	const digest = await subtle().digest("SHA-256", toArrayBuffer(bytes));
	return bytesToHex(digest);
}

/** HMAC-SHA256 over an arbitrary UTF-8 message, base64url-encoded, matching
 * the server's devsync.Sign. secret is treated as raw UTF-8 bytes (the
 * pairing response's "secret" field, itself base64url text used verbatim as
 * key material by the server — see devsync.Sign(secret, ...)). */
export async function hmacB64url(secret: string, message: string): Promise<string> {
	const key = await subtle().importKey(
		"raw",
		toArrayBuffer(textToBytes(secret)),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"]
	);
	const sig = await subtle().sign("HMAC", key, toArrayBuffer(textToBytes(message)));
	return bytesToBase64Url(sig);
}

/** A fresh cryptographically random nonce, base64url text, comfortably
 * inside the server's accepted length range (16-128 chars). 16 random bytes
 * base64url-encode to 22 characters. */
export function randomNonce(): string {
	const bytes = new Uint8Array(16);
	const c = (globalThis as any).crypto as Crypto;
	c.getRandomValues(bytes);
	return bytesToBase64Url(bytes);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
	// Slice to guarantee a plain ArrayBuffer (Uint8Array may be backed by a
	// larger/shared buffer), which subtle.digest/importKey/sign require.
	return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
