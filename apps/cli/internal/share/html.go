package share

import (
	"bytes"
	"errors"
	"io"
	"net/http"
	"strings"

	"golang.org/x/net/html"
)

const previewPolicy = "default-src 'self' data: blob:; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self'; worker-src 'none'; child-src 'none'; object-src 'none'; base-uri 'self'; form-action 'self'"

// Inspect only a bounded prelude. Preserve the original document bytes and
// doctype, and place the shim before application scripts.
func injectHTML(source io.Reader, injection string) (io.Reader, error) {
	z := html.NewTokenizer(source)
	z.SetMaxBuf(64 << 10)
	var prelude bytes.Buffer
	insert := -1
	finish := func() io.Reader {
		if insert < 0 {
			insert = 0
		}
		data := prelude.Bytes()
		return io.MultiReader(bytes.NewReader(data[:insert]), strings.NewReader(injection), bytes.NewReader(data[insert:]), bytes.NewReader(z.Buffered()), source)
	}
	for {
		kind := z.Next()
		raw := append([]byte(nil), z.Raw()...)
		if prelude.Len()+len(raw) > 64<<10 {
			return nil, errors.New("WEB_UNSUPPORTED_HTML")
		}
		if kind == html.ErrorToken {
			if z.Err() != io.EOF {
				return nil, errors.New("WEB_UNSUPPORTED_HTML")
			}
			prelude.Write(raw)
			return finish(), nil
		}
		token := z.Token()
		if kind == html.StartTagToken || kind == html.SelfClosingTagToken {
			if token.Data == "meta" {
				var equivalent, content string
				for _, a := range token.Attr {
					switch a.Key {
					case "http-equiv":
						equivalent = strings.ToLower(strings.TrimSpace(a.Val))
					case "content":
						content = a.Val
					}
				}
				h := http.Header{}
				if equivalent == "content-security-policy" {
					h.Set("Content-Security-Policy", content)
				}
				if equivalent == "x-frame-options" {
					h.Set("X-Frame-Options", content)
				}
				if !canInject(h) {
					return nil, errors.New("WEB_UNSUPPORTED_SECURITY_POLICY")
				}
			}
			if token.Data == "script" || token.Data == "body" {
				prelude.Write(raw)
				return finish(), nil
			}
		}
		prelude.Write(raw)
		if kind == html.DoctypeToken && insert < 0 {
			insert = prelude.Len()
		}
		if kind == html.StartTagToken && (token.Data == "html" || token.Data == "head") {
			insert = prelude.Len()
		}
		if kind == html.EndTagToken && token.Data == "head" {
			return finish(), nil
		}
	}
}
