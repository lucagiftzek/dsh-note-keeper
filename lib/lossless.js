// ---- lossless: sanitize a tool result for DSH 0.2.1 (identical block in shared/lossless.js and plugin-errors.js) ----
/**
 * DSH 0.2.1 validates every agent tool result with util-values `snapshotJsonValue`
 * and rejects it as `tool "<name>" returned invalid output: value is not lossless JSON`
 * when ANY nested value is: undefined, a function or symbol, bigint, NaN, +-Infinity,
 * -0, a Date/Map/Set/Error/class instance (non-plain prototype), a sparse array, an
 * array with extra props, an object with symbol or non-enumerable keys, or a cycle.
 * toLossless() converts a value into the nearest JSON equivalent with the same rules
 * JSON.stringify applies (undefined/function/symbol keys dropped, in arrays -> null).
 * It never throws.
 */
export function toLossless(value, _seen = new Set(), _depth = 0) {
  if (value === null) return null
  switch (typeof value) {
    case 'string': case 'boolean': return value
    case 'number': return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null
    case 'bigint': return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString()
    case 'undefined': case 'function': case 'symbol': return null
  }
  if (_depth > 64) return '[Truncated]'
  if (_seen.has(value)) return '[Circular]'
  _seen.add(value)
  try {
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
    if (typeof value.toJSON === 'function' && !Array.isArray(value)) {
      let j
      try { j = value.toJSON() } catch { j = undefined }
      if (j !== value) return toLossless(j, _seen, _depth + 1)
    }
    if (Array.isArray(value)) {
      const out = []
      for (let i = 0; i < value.length; i++) out.push(toLossless(value[i], _seen, _depth + 1))
      return out
    }
    if (value instanceof Set) return Array.from(value, (v) => toLossless(v, _seen, _depth + 1))
    if (value instanceof Error) {
      const out = { name: String(value.name), message: String(value.message) }
      if (typeof value.code === 'string') out.code = value.code
      return out
    }
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return Array.from(new Uint8Array(value.buffer || value, value.byteOffset || 0, value.byteLength))
    const src = value instanceof Map ? Object.fromEntries(Array.from(value, ([k, v]) => [String(k), v])) : value
    const out = {}
    for (const k of Object.keys(src)) {
      let v
      try { v = src[k] } catch { continue }
      if (v === undefined || typeof v === 'function' || typeof v === 'symbol') continue
      Object.defineProperty(out, k, { value: toLossless(v, _seen, _depth + 1), enumerable: true, configurable: true, writable: true })
    }
    return out
  } finally { _seen.delete(value) }
}

/** Wrap a harness defineTool so every execute() result (success AND error returns) is sanitized. */
export function losslessDefineTool(defineTool) {
  if (typeof defineTool !== 'function') return defineTool
  const wrapped = (def) => {
    if (!def || typeof def.execute !== 'function') return defineTool(def)
    const execute = def.execute
    return defineTool({ ...def, execute: async function (...a) { return toLossless(await execute.apply(this, a)) } })
  }
  return wrapped
}
// ---- end lossless ----
