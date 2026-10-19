package share

import (
	"io"
	"strings"
	"testing"
)

func TestRecoveredHTMLPreservesDocumentAndInjectsBeforeScripts(t *testing.T) {
	const shim = `<script src="/.tailmouse/shim.js"></script>`
	for _, document := range []string{
		`<!doctype html><html><head><meta charset="utf-8"><script>window.app=true</script></head><body>hello</body></html>`,
		`<!doctype html><html><body><h1>hello</h1></body></html>`,
		`<h1>hello</h1>`, `plain text`, ``,
		`<body>` + strings.Repeat("body text ", 10000) + `</body>`,
	} {
		r, err := injectHTML(strings.NewReader(document), shim)
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(r)
		if err != nil {
			t.Fatal(err)
		}
		got := string(data)
		if strings.Count(got, shim) != 1 || strings.Replace(got, shim, "", 1) != document {
			t.Fatal("original document bytes changed")
		}
		if strings.HasPrefix(document, "<!doctype") && !strings.HasPrefix(got, "<!doctype") {
			t.Fatal("doctype moved")
		}
		if i := strings.Index(got, "<script>window.app"); i >= 0 && strings.Index(got, shim) > i {
			t.Fatal("application ran before shim")
		}
	}
}

func TestRecoveredHTMLRejectsIncompatiblePoliciesAndUnboundedPrelude(t *testing.T) {
	for _, document := range []string{
		`<head><meta http-equiv="Content-Security-Policy" content="script-src 'none'"></head>`,
		`<head><meta http-equiv="X-Frame-Options" content="DENY"></head>`,
		strings.Repeat("x", 65537),
	} {
		if _, err := injectHTML(strings.NewReader(document), "shim"); err == nil {
			t.Fatal("unsupported document accepted")
		}
	}
}
