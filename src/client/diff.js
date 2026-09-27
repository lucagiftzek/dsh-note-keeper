/**
 * Line diff (LCS) for the AI Enhance preview. Pure; O(n*m) memory is bounded
 * by MAX_CELLS, beyond which a coarse "all removed / all added" diff is used.
 */
const MAX_CELLS = 4_000_000

/** @returns {{ type: 'same'|'add'|'del', text: string }[]} */
export function diffLines(a, b) {
  const x = a.split('\n')
  const y = b.split('\n')
  // Trim common head and tail first (the usual case for edits).
  let s = 0
  while (s < x.length && s < y.length && x[s] === y[s]) s++
  let e = 0
  while (e < x.length - s && e < y.length - s && x[x.length - 1 - e] === y[y.length - 1 - e]) e++
  const xm = x.slice(s, x.length - e)
  const ym = y.slice(s, y.length - e)
  const out = x.slice(0, s).map((text) => ({ type: 'same', text }))
  if (xm.length * ym.length > MAX_CELLS) {
    for (const text of xm) out.push({ type: 'del', text })
    for (const text of ym) out.push({ type: 'add', text })
  } else {
    const n = xm.length
    const m = ym.length
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = xm[i] === ym[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1])
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (xm[i] === ym[j]) { out.push({ type: 'same', text: xm[i] }); i++; j++ } else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ type: 'del', text: xm[i++] }) } else { out.push({ type: 'add', text: ym[j++] }) }
    }
    while (i < n) out.push({ type: 'del', text: xm[i++] })
    while (j < m) out.push({ type: 'add', text: ym[j++] })
  }
  for (const text of x.slice(x.length - e)) out.push({ type: 'same', text })
  return out
}

/** Summary counts for a diff. */
export function diffStats(d) {
  let add = 0
  let del = 0
  for (const r of d) { if (r.type === 'add') add++; else if (r.type === 'del') del++ }
  return { add, del }
}
