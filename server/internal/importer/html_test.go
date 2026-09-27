package importer

import (
	"strings"
	"testing"
)

func TestConvertHTMLHeadingsAndInline(t *testing.T) {
	doc := "<html><head><title>Doc Title</title></head><body>" +
		"<h1>Heading</h1><p>Some <strong>bold</strong> and <em>italic</em> and <s>gone</s> text.</p>" +
		"<p>Line one<br>Line two</p><hr>" +
		"</body></html>"
	title, md := ConvertHTML([]byte(doc))
	if title != "Doc Title" {
		t.Fatalf("title = %q", title)
	}
	for _, want := range []string{"# Heading", "**bold**", "*italic*", "~~gone~~", "Line one  \nLine two", "---"} {
		if !strings.Contains(md, want) {
			t.Errorf("missing %q in:\n%s", want, md)
		}
	}
}

func TestConvertHTMLTitleFallsBackToFirstH1(t *testing.T) {
	doc := "<html><body><h1>Fallback Title</h1><p>text</p></body></html>"
	title, _ := ConvertHTML([]byte(doc))
	if title != "Fallback Title" {
		t.Fatalf("title = %q", title)
	}
}

func TestConvertHTMLLinksAndImages(t *testing.T) {
	doc := "<p><a href=\"https://example.com\">Example</a> and <img src=\"pic.png\" alt=\"A pic\"></p>"
	_, md := ConvertHTML([]byte(doc))
	if !strings.Contains(md, "[Example](https://example.com)") {
		t.Errorf("link missing: %s", md)
	}
	if !strings.Contains(md, "![A pic](pic.png)") {
		t.Errorf("image missing: %s", md)
	}
}

func TestConvertHTMLCodeAndPre(t *testing.T) {
	doc := "<p>Use <code>fmt.Println</code> here.</p>" +
		"<pre><code class=\"language-go\">func main() {}</code></pre>"
	_, md := ConvertHTML([]byte(doc))
	if !strings.Contains(md, "`fmt.Println`") {
		t.Errorf("inline code missing: %s", md)
	}
	if !strings.Contains(md, "```go\nfunc main() {}\n```") {
		t.Errorf("fenced code missing: %s", md)
	}
}

func TestConvertHTMLBlockquote(t *testing.T) {
	doc := "<blockquote><p>Quoted text</p></blockquote>"
	_, md := ConvertHTML([]byte(doc))
	if !strings.Contains(md, "> Quoted text") {
		t.Errorf("blockquote missing: %s", md)
	}
}

func TestConvertHTMLNestedLists(t *testing.T) {
	doc := "<ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>" +
		"<ol start=\"3\"><li>Three</li><li>Four</li></ol>"
	_, md := ConvertHTML([]byte(doc))
	t.Logf("md:\n%s", md)
	if !strings.Contains(md, "- One") || !strings.Contains(md, "  - Nested") || !strings.Contains(md, "- Two") {
		t.Errorf("unordered nesting wrong: %s", md)
	}
	if !strings.Contains(md, "3. Three") || !strings.Contains(md, "4. Four") {
		t.Errorf("ordered numbering wrong: %s", md)
	}
}

func TestConvertHTMLChecklistItems(t *testing.T) {
	doc := "<ul>" +
		"<li><input type=\"checkbox\" checked>Done thing</li>" +
		"<li><input type=\"checkbox\">Todo thing</li>" +
		"</ul>"
	_, md := ConvertHTML([]byte(doc))
	if !strings.Contains(md, "- [x] Done thing") {
		t.Errorf("checked item wrong: %s", md)
	}
	if !strings.Contains(md, "- [ ] Todo thing") {
		t.Errorf("unchecked item wrong: %s", md)
	}
}

func TestConvertHTMLTable(t *testing.T) {
	doc := "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>"
	_, md := ConvertHTML([]byte(doc))
	want := []string{"| A | B |", "| --- | --- |", "| 1 | 2 |"}
	for _, w := range want {
		if !strings.Contains(md, w) {
			t.Errorf("missing %q in:\n%s", w, md)
		}
	}
}

func TestConvertHTMLScriptStyleStripped(t *testing.T) {
	doc := "<html><head><style>body{color:red}</style></head><body>" +
		"<script>alert(1)</script><p>Visible</p></body></html>"
	_, md := ConvertHTML([]byte(doc))
	if strings.Contains(md, "alert") || strings.Contains(md, "color:red") {
		t.Errorf("script/style leaked into: %s", md)
	}
	if !strings.Contains(md, "Visible") {
		t.Errorf("visible text missing: %s", md)
	}
}
