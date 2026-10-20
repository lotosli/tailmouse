package share

import (
	"strings"

	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestResourceCommands(t *testing.T) {
	cases := []struct {
		args  []string
		valid bool
	}{{[]string{"cli", "--", "bash"}, true}, {[]string{"web", "8080"}, true}, {[]string{"receive", "./uploads"}, true}, {[]string{"dev", "--web", "5173", "--receive", "./uploads", "--", "codex"}, true}, {[]string{"dev", "--cli", "codex", "--web", "localhost:5173"}, true}, {[]string{"dev", "--web", "8080", "--receive", "./uploads"}, true}, {[]string{"dev", "--web", "8080"}, false}, {[]string{"cli"}, false}, {[]string{"dev", "--cli", "codex", "--web", "8080", "--", "bash"}, false}, {[]string{"web", "--max-clients", "5", "8080"}, false}, {[]string{"cli", "--ttl", "-1s", "--", "bash"}, false}, {[]string{"web", "https://u:p@localhost"}, false}, {[]string{"web", "0.0.0.0:80"}, false}, {[]string{"web", "ftp://localhost"}, false}, {[]string{"web", "--max-file", "2GiB", "8080"}, false}}
	for _, c := range cases {
		t.Run(c.args[0], func(t *testing.T) {
			o, h, e := Parse(c.args, nil, t.TempDir())
			if (e == nil) != c.valid || h {
				t.Fatalf("valid=%v help=%v err=%v", c.valid, h, e)
			}
			if e == nil && (o.TTL != time.Hour || o.MaxClients != 1 || o.Approval != "auto" || o.FrontendBase != "https://tailmouse.com" || o.ContentBase != o.FrontendBase || !o.TestSingleOrigin) {
				t.Fatal("hosted defaults or session limits changed")
			}
		})
	}
}
func TestConfigPrecedence(t *testing.T) {
	dir := t.TempDir()
	if e := os.Mkdir(filepath.Join(dir, "tailmouse"), 0700); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(filepath.Join(dir, "tailmouse", "config.toml"), []byte("version = 1\n[share]\nttl = '2h'\nmax-clients = 2\n"), 0600); e != nil {
		t.Fatal(e)
	}
	o, _, e := Parse([]string{"web", "--ttl", "30m", "8080"}, []string{"TAILMOUSE_TTL=3h"}, dir)
	if e != nil || o.TTL != 30*time.Minute || o.MaxClients != 2 || o.ContentBase != "https://tailmouse.com" || !o.TestSingleOrigin {
		t.Fatal("precedence", e)
	}
	if _, h, e := Parse([]string{"cli", "--help"}, nil, t.TempDir()); e != nil || !h {
		t.Fatal("help", e)
	}
}

func TestHostedDefaultsRespectDeploymentOverrides(t *testing.T) {
	for _, tc := range []struct {
		name, file          string
		flags, env          []string
		valid, singleOrigin bool
		front, content      string
	}{
		{name: "custom flag origins", flags: []string{"--frontend-base=https://ui.example.com", "--content-base=https://preview.example.net"}, valid: true, front: "https://ui.example.com", content: "https://preview.example.net"},
		{name: "custom environment content", env: []string{"TAILMOUSE_CONTENT_BASE=https://preview.example.net"}, valid: true, front: "https://tailmouse.com", content: "https://preview.example.net"},
		{name: "custom file origins", file: "frontend-base = 'https://ui.example.com'\ncontent-base = 'https://preview.example.net'", valid: true, front: "https://ui.example.com", content: "https://preview.example.net"},
		{name: "missing custom content", flags: []string{"--frontend-base=https://ui.example.com"}},
		{name: "custom same origin needs permission", env: []string{"TAILMOUSE_FRONTEND_BASE=https://ui.example.com", "TAILMOUSE_CONTENT_BASE=https://ui.example.com"}},
		{name: "explicit custom test mode", flags: []string{"--test-single-origin"}, env: []string{"TAILMOUSE_FRONTEND_BASE=https://ui.example.com", "TAILMOUSE_CONTENT_BASE=https://ui.example.com"}, valid: true, singleOrigin: true, front: "https://ui.example.com", content: "https://ui.example.com"},
		{name: "explicit flag opt out", flags: []string{"--test-single-origin=false"}, env: []string{"TAILMOUSE_TEST_SINGLE_ORIGIN=true"}},
		{name: "explicit environment opt out", env: []string{"TAILMOUSE_TEST_SINGLE_ORIGIN=false"}},
		{name: "explicit file opt out", file: "test-single-origin = false"},
		{name: "environment overrides file mode", file: "test-single-origin = false", env: []string{"TAILMOUSE_TEST_SINGLE_ORIGIN=true"}, valid: true, singleOrigin: true, front: "https://tailmouse.com", content: "https://tailmouse.com"},
		{name: "malformed file", file: "not valid TOML"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			args := append([]string{"web", "8080"}, tc.flags...)
			if tc.file != "" {
				path := filepath.Join(dir, "config.toml")
				if err := os.WriteFile(path, []byte("version = 1\n[share]\n"+tc.file), 0600); err != nil {
					t.Fatal(err)
				}
				args = append(args, "--config", path)
			}
			o, help, err := Parse(args, tc.env, dir)
			if (err == nil) != tc.valid || help {
				t.Fatalf("valid=%v help=%v err=%v", tc.valid, help, err)
			}
			if tc.valid && (o.FrontendBase != tc.front || o.ContentBase != tc.content || o.TestSingleOrigin != tc.singleOrigin) {
				t.Fatal("configured deployment was replaced by hosted defaults")
			}
		})
	}
	for _, source := range []string{"flag", "environment"} {
		t.Run("explicit missing file "+source, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "missing.json")
			args, env := []string{"web", "8080"}, []string{}
			if source == "flag" {
				args = append(args, "--config", path)
			} else {
				env = append(env, "TAILMOUSE_CONFIG="+path)
			}
			if _, _, err := Parse(args, env, dir); err != ErrConfig {
				t.Fatal("missing explicit file fell back to hosted defaults")
			}
		})
	}
}
func TestSizesTargetsOrigins(t *testing.T) {
	for input, want := range map[string]int64{"1KiB": 1024, "1KB": 1000, "2GiB": 2 << 30, "0B": 0} {
		got, e := ParseSize(input)
		if e != nil || got != want {
			t.Fatal(input, got, e)
		}
	}
	for _, v := range []string{"1mb", "1", "-1B", "9007199254740992B", "1.5MiB"} {
		if _, e := ParseSize(v); e == nil {
			t.Fatal(v)
		}
	}
	for _, v := range []string{"8080", "localhost:8080", "[::1]:8080", "https://example.com:8443/admin?x=1#section"} {
		if _, e := ParseTarget(v); e != nil {
			t.Fatal(v, e)
		}
	}
	if e := ValidateOrigins("https://ui.example.com", "https://app.example.com"); e == nil {
		t.Fatal("same registrable domain accepted")
	}
	if e := ValidateOrigins("https://ui.example.com", "https://app.example.net"); e != nil {
		t.Fatal(e)
	}
}

func TestSingleOriginRequiresExplicitTestDeployment(t *testing.T) {
	base := "https://tailmouse.com"
	if ValidateOrigins(base, base) == nil {
		t.Fatal("single-origin production deployment accepted")
	}
	if validateOrigins(base, base, true) != nil {
		t.Fatal("explicit test deployment rejected")
	}
	for _, target := range []string{"https://child.tailmouse.com", "http://tailmouse.com", "https://tailmouse.com/path"} {
		if validateOrigins(base, target, true) == nil {
			t.Fatal("test option accepted mismatched or insecure deployment")
		}
	}
	options, _, err := Parse([]string{"web", "8080", "--frontend-base", base, "--content-base", base, "--test-single-origin"}, nil, t.TempDir())
	if err != nil || !options.TestSingleOrigin {
		t.Fatal("test deployment option was not explicit")
	}
}

func TestDeploymentConfigurationAndOverrides(t *testing.T) {
	valid := `{"version":1,"frontendBase":"https://tailmouse.com","contentBase":"https://tailmouse.com","testSingleOrigin":true,"releaseManifest":"/web-manifest.json"}`
	dir := t.TempDir()
	name := filepath.Join(dir, "deployment.json")
	if err := os.WriteFile(name, []byte(valid), 0600); err != nil {
		t.Fatal(err)
	}
	o, _, err := Parse([]string{"web", "--config", name, "--ttl", "30m", "8080"}, []string{"TAILMOUSE_TTL=2h"}, dir)
	if err != nil || o.FrontendBase != "https://tailmouse.com" || !o.TestSingleOrigin || o.TTL != 30*time.Minute {
		t.Fatal("deployment precedence", err)
	}
	target, err := ParseTarget(o.Target)
	if err != nil || target.Host != "127.0.0.1:8080" {
		t.Fatal("port-only target is not explicit loopback")
	}
	for _, bad := range []string{
		valid + `{}`, strings.Replace(valid, `"version":1`, `"version":2`, 1),
		strings.Replace(valid, `"version":1`, `"version":1,"unknown":true`, 1),
		strings.Replace(valid, `"testSingleOrigin":true`, `"testSingleOrigin":false`, 1),
		strings.Replace(valid, `/web-manifest.json`, `https://other.invalid/manifest.json`, 1),
		strings.Repeat(" ", 4097) + valid,
	} {
		if err := os.WriteFile(name, []byte(bad), 0600); err != nil {
			t.Fatal(err)
		}
		if _, _, err := Parse([]string{"web", "--config", name, "8080"}, nil, dir); err != ErrConfig {
			t.Fatal("invalid deployment accepted", err)
		}
	}
}
