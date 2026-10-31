/**
 * Attachment upload transport + sealed (encrypted) uploads. Kept free of React
 * so the exact browser flow can be tested against the real daemon.
 */
import { sealBlobMeta, opaqueName } from './crypto.js'

/** Slice size. Every request stays well under the edge's 100 MB body cap. */
export const CHUNK = 64 * 1024 * 1024

/**
 * Upload one attachment. Bodies up to one slice go in a single request;
 * larger ones use begin -> chunk* -> finish. Any failure aborts the
 * server-side session so no staging file lingers.
 */
export async function putFile(api, blob, name, dir, encrypted, onProgress, chunk = CHUNK) {
  if (blob.size <= chunk) return api.upload(blob, name, dir, encrypted)
  const beg = await api.uploadBegin(name, dir, blob.size, encrypted)
  try {
    for (let off = 0; off < blob.size; off += chunk) {
      const r = await api.uploadChunk(beg.id, blob.slice(off, Math.min(off + chunk, blob.size)))
      if (onProgress) onProgress(r.received / blob.size)
    }
    return await api.uploadFinish(beg.id)
  } catch (e) {
    try { await api.uploadAbort(beg.id) } catch { /* already gone */ }
    throw e
  }
}

/**
 * Seal a file in the browser and upload it under an opaque random name. The
 * original name, size and type travel only inside the ciphertext, so neither
 * the connection (URLs, bodies) nor the vault (file names, bytes) reveals what
 * the file was. Returns the server's { path, bytes, name } answer.
 */
export async function putSealed(api, key, blob, name, dir, onProgress, chunk = CHUNK) {
  const sealed = await sealBlobMeta(key, new Uint8Array(await blob.arrayBuffer()), { name, size: blob.size, type: blob.type || '' })
  return putFile(api, new Blob([sealed]), opaqueName() + '.nkenc', dir, true, onProgress, chunk)
}
