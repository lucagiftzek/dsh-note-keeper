// Package importer: html.go converts a single HTML document to Markdown
// using golang.org/x/net/html, well enough to round-trip a note export
// (headings, paragraphs, emphasis, links, images, lists including nested
// and checkbox items, code, blockquotes, rules and GFM tables). It is also
// reused, after a light preprocessing pass, to render Evernote's ENML.
package importer

import (
	"bytes"
	"fmt"
	"strconv"
	"strings"

	"golang.org/x/net/html"
)

// listFrame tracks one active <ul>/<ol> while walking the DOM.
type listFrame struct {
	ordered bool
	idx     int
}

// htmlConv holds the state of one HTML-to-Markdown conversion.
type htmlConv struct {
	buf       *strings.Builder
	title     string
	firstH1   string
	listStack []*listFrame
}

// ConvertHTML renders an HTML document as Markdown. It returns a title
// (from <title>, falling back to the first <h1>) alongside the body.
func ConvertHTML(data []byte) (title string, markdown string) {
	doc, err := html.Parse(bytes.NewReader(data))
	if err != nil {
		// Not parseable as HTML: fall back to the raw text, verbatim.
		return "", strings.TrimSpace(string(data)) + "\n"
	}
	c := &htmlConv{buf: &strings.Builder{}}
	c.writeNode(doc)
	title = c.title
	if title == "" {
		title = c.firstH1
	}
	body := strings.TrimSpace(collapseBlankLines(c.buf.String()))
	if body != "" {
		body += "\n"
	}
	return title, body
}

// collapseBlankLines turns three or more consecutive newlines into exactly
// two (a single blank line), the Markdown convention for a paragraph break.
func collapseBlankLines(s string) string {
	for strings.Contains(s, "\n\n\n") {
		s = strings.ReplaceAll(s, "\n\n\n", "\n\n")
	}
	return s
}

// blockBreak ensures the buffer ends with exactly one blank line, ready for
// the next block-level element. It is a no-op on an empty buffer.
func (c *htmlConv) blockBreak() {
	s := strings.TrimRight(c.buf.String(), "\n")
	c.buf.Reset()
	if s == "" {
		return
	}
	c.buf.WriteString(s)
	c.buf.WriteString("\n\n")
}

// capture renders n's children into a fresh buffer and returns the result,
// leaving the conversion's main buffer untouched. Used by inline wrapper
// tags (strong, em, a, ...) that need their content before deciding what to
// emit around it.
func (c *htmlConv) capture(n *html.Node) string {
	saved := c.buf
	c.buf = &strings.Builder{}
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		c.writeNode(ch)
	}
	out := c.buf.String()
	c.buf = saved
	return out
}

// writeNode renders one DOM node (and, for containers, its children) as
// Markdown into c.buf.
func (c *htmlConv) writeNode(n *html.Node) {
	switch n.Type {
	case html.TextNode:
		c.buf.WriteString(collapseWS(n.Data))
		return
	case html.CommentNode, html.DoctypeNode:
		return
	}
	if n.Type != html.ElementNode {
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			c.writeNode(ch)
		}
		return
	}

	switch n.Data {
	case "script", "style", "noscript":
		return
	case "title":
		c.title = strings.TrimSpace(collapseWS(textContent(n)))
		return
	case "h1", "h2", "h3", "h4", "h5", "h6":
		level := int(n.Data[1] - '0')
		text := strings.TrimSpace(collapseWS(c.capture(n)))
		if level == 1 && c.firstH1 == "" {
			c.firstH1 = text
		}
		c.blockBreak()
		c.buf.WriteString(strings.Repeat("#", level) + " " + text)
		c.blockBreak()
		return
	case "p", "div", "section", "article":
		text := strings.TrimSpace(c.capture(n))
		if text == "" {
			return
		}
		c.blockBreak()
		c.buf.WriteString(text)
		c.blockBreak()
		return
	case "br":
		c.buf.WriteString("  \n")
		return
	case "hr":
		c.blockBreak()
		c.buf.WriteString("---")
		c.blockBreak()
		return
	case "strong", "b":
		text := strings.TrimSpace(c.capture(n))
		if text == "" {
			return
		}
		c.buf.WriteString("**" + text + "**")
		return
	case "em", "i":
		text := strings.TrimSpace(c.capture(n))
		if text == "" {
			return
		}
		c.buf.WriteString("*" + text + "*")
		return
	case "s", "del", "strike":
		text := strings.TrimSpace(c.capture(n))
		if text == "" {
			return
		}
		c.buf.WriteString("~~" + text + "~~")
		return
	case "code":
		c.buf.WriteString("\x60" + collapseWS(strings.TrimSpace(textContent(n))) + "\x60")
		return
	case "a":
		href := attrVal(n, "href")
		text := strings.TrimSpace(c.capture(n))
		if text == "" {
			text = href
		}
		if href == "" {
			c.buf.WriteString(text)
		} else {
			c.buf.WriteString("[" + text + "](" + href + ")")
		}
		return
	case "img":
		alt := attrVal(n, "alt")
		src := attrVal(n, "src")
		c.buf.WriteString("![" + alt + "](" + src + ")")
		return
	case "blockquote":
		inner := strings.TrimSpace(c.capture(n))
		if inner == "" {
			return
		}
		lines := strings.Split(inner, "\n")
		for i, l := range lines {
			lines[i] = "> " + l
		}
		c.blockBreak()
		c.buf.WriteString(strings.Join(lines, "\n"))
		c.blockBreak()
		return
	case "pre":
		c.blockBreak()
		lang := ""
		if fe := firstElementChild(n); fe != nil && fe.Data == "code" {
			if cls := attrVal(fe, "class"); strings.HasPrefix(cls, "language-") {
				lang = strings.TrimPrefix(cls, "language-")
			}
		}
		raw := strings.Trim(textContent(n), "\n")
		c.buf.WriteString("\x60\x60\x60" + lang + "\n" + raw + "\n\x60\x60\x60")
		c.blockBreak()
		return
	case "ul", "ol":
		c.blockBreak()
		c.writeList(n)
		c.blockBreak()
		return
	case "table":
		c.blockBreak()
		c.writeTable(n)
		c.blockBreak()
		return
	default:
		for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
			c.writeNode(ch)
		}
		return
	}
}

// writeList renders one <ul>/<ol> element's <li> children.
func (c *htmlConv) writeList(n *html.Node) {
	ordered := n.Data == "ol"
	start := 1
	if v := attrVal(n, "start"); v != "" {
		if iv, err := strconv.Atoi(v); err == nil {
			start = iv
		}
	}
	c.listStack = append(c.listStack, &listFrame{ordered: ordered, idx: start})
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type == html.ElementNode && ch.Data == "li" {
			c.writeLi(ch)
		}
	}
	c.listStack = c.listStack[:len(c.listStack)-1]
}

// writeLi renders one <li>, including a leading checkbox input as a task
// list marker ("- [ ] "/"- [x] ") and any nested <ul>/<ol> at the next
// indent depth.
func (c *htmlConv) writeLi(li *html.Node) {
	depth := len(c.listStack) - 1
	indent := strings.Repeat("  ", depth)
	frame := c.listStack[depth]

	var checkboxNode *html.Node
	checkbox := ""
	if fe := firstElementChild(li); fe != nil && fe.Data == "input" && strings.EqualFold(attrVal(fe, "type"), "checkbox") {
		checkboxNode = fe
		if hasAttr(fe, "checked") {
			checkbox = "[x] "
		} else {
			checkbox = "[ ] "
		}
	}
	marker := "- "
	if frame.ordered && checkbox == "" {
		marker = fmt.Sprintf("%d. ", frame.idx)
	}
	if frame.ordered {
		frame.idx++
	}

	var inline strings.Builder
	var nested []*html.Node
	for ch := li.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch == checkboxNode {
			continue
		}
		if ch.Type == html.ElementNode && (ch.Data == "ul" || ch.Data == "ol") {
			nested = append(nested, ch)
			continue
		}
		saved := c.buf
		c.buf = &strings.Builder{}
		c.writeNode(ch)
		inline.WriteString(c.buf.String())
		c.buf = saved
	}
	text := strings.TrimSpace(collapseWS(inline.String()))
	c.buf.WriteString(indent + marker + checkbox + text + "\n")
	for _, nd := range nested {
		c.writeNode(nd)
	}
}

// writeTable renders every <tr> reachable under n (any nesting of
// thead/tbody/tfoot) as a GFM table. The first row is treated as the
// header, per GFM's requirement of a header + separator row.
func (c *htmlConv) writeTable(n *html.Node) {
	var rows [][]string
	var walk func(*html.Node)
	walk = func(nd *html.Node) {
		if nd.Type == html.ElementNode && nd.Data == "tr" {
			var cells []string
			for ch := nd.FirstChild; ch != nil; ch = ch.NextSibling {
				if ch.Type == html.ElementNode && (ch.Data == "td" || ch.Data == "th") {
					text := strings.TrimSpace(collapseWS(c.capture(ch)))
					text = strings.ReplaceAll(text, "|", "\\|")
					cells = append(cells, text)
				}
			}
			if len(cells) > 0 {
				rows = append(rows, cells)
			}
			return
		}
		for ch := nd.FirstChild; ch != nil; ch = ch.NextSibling {
			walk(ch)
		}
	}
	walk(n)
	if len(rows) == 0 {
		return
	}
	width := len(rows[0])
	writeRow := func(cells []string) {
		for len(cells) < width {
			cells = append(cells, "")
		}
		c.buf.WriteString("| " + strings.Join(cells[:width], " | ") + " |\n")
	}
	writeRow(rows[0])
	sep := make([]string, width)
	for i := range sep {
		sep[i] = "---"
	}
	c.buf.WriteString("| " + strings.Join(sep, " | ") + " |\n")
	for _, r := range rows[1:] {
		writeRow(r)
	}
}

// ---- small DOM helpers -----------------------------------------------------

func attrVal(n *html.Node, key string) string {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return a.Val
		}
	}
	return ""
}

func hasAttr(n *html.Node, key string) bool {
	for _, a := range n.Attr {
		if strings.EqualFold(a.Key, key) {
			return true
		}
	}
	return false
}

func firstElementChild(n *html.Node) *html.Node {
	for ch := n.FirstChild; ch != nil; ch = ch.NextSibling {
		if ch.Type == html.ElementNode {
			return ch
		}
	}
	return nil
}

func textContent(n *html.Node) string {
	var b strings.Builder
	var walk func(*html.Node)
	walk = func(nd *html.Node) {
		if nd.Type == html.TextNode {
			b.WriteString(nd.Data)
		}
		for ch := nd.FirstChild; ch != nil; ch = ch.NextSibling {
			walk(ch)
		}
	}
	walk(n)
	return b.String()
}
