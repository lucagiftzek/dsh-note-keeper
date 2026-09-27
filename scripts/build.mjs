/**
 * Build the browser half (lib/client.js) in the DSH web client-module format:
 * CJS wrapped in window.__ModuleLoader__.load({ id, factory }). React comes
 * from the shell (external); marked and DOMPurify are bundled. The host half
 * (lib/*.js) is plain ESM and needs no build.
 */
import { build } from 'esbuild'
import { readFileSync, statSync } from 'node:fs'
import { stubLangHtml } from './esbuild-plugins.mjs'

const ID = 'dsh-note-keeper'
await build({
  entryPoints: ['src/client/index.jsx'],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  outfile: 'lib/client.js',
  sourcemap: true,
  minify: process.env.NK_MINIFY !== '0',
  jsx: 'automatic',
  loader: { '.jsx': 'jsx' },
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  define: { 'process.env.NODE_ENV': '"production"' },
  legalComments: 'linked',
  plugins: [stubLangHtml],
  banner: { js: 'window.__ModuleLoader__.load({ id: ' + JSON.stringify(ID) + ', factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;' },
  footer: { js: 'return module.exports; } });' },
})
const out = readFileSync('lib/client.js', 'utf8')
if (out.includes('@deepseek-ai/')) throw new Error('client bundle must not inline @deepseek-ai packages')
console.log('built lib/client.js (' + Math.round(statSync('lib/client.js').size / 1024) + ' KB)')
