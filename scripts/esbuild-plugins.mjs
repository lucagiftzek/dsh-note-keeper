// Shared esbuild plugins for the client bundle and the jsdom UI test.
import { fileURLToPath } from 'node:url'

const STUB = fileURLToPath(new URL('../src/client/cm/html-stub.js', import.meta.url))

/** Replace @codemirror/lang-html with a tiny stub (see html-stub.js). */
export const stubLangHtml = {
  name: 'stub-lang-html',
  setup(b) {
    b.onResolve({ filter: /^@codemirror\/lang-html$/ }, () => ({ path: STUB }))
  },
}
