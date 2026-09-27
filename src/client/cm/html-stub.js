/**
 * Build-time stand-in for @codemirror/lang-html (about 180 KB of HTML, CSS
 * and JavaScript grammars that @codemirror/lang-markdown imports only to
 * highlight raw HTML blocks). Notes rarely contain HTML, so HTML blocks are
 * left as plain text instead. Wired in by scripts/esbuild-plugins.mjs.
 */
import { Parser, Tree, NodeType } from '@lezer/common'

class PlainParser extends Parser {
  createParse(input, fragments, ranges) {
    const from = ranges && ranges.length ? ranges[0].from : 0
    const to = ranges && ranges.length ? ranges[ranges.length - 1].to : input.length
    return {
      parsedPos: to,
      stoppedAt: null,
      stopAt() {},
      advance: () => new Tree(NodeType.none, [], [], to - from),
    }
  }
}

const plain = new PlainParser()

export function html() {
  return { support: [], language: { parser: plain } }
}

export function htmlCompletionSource() {
  return null
}
