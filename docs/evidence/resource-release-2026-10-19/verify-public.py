"""Read-only verification of the owner's static tailmouse.com test release.

Usage: python3 verify-public.py LOCAL_WEB_MANIFEST OUTPUT_JSON
Uses the configured HTTPS proxy and system trust store; never disables TLS.
"""

import hashlib
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ORIGIN = "https://tailmouse.com"
manifest_bytes = Path(sys.argv[1]).read_bytes()
assert len(manifest_bytes) <= 2 * 1024 * 1024
manifest = json.loads(manifest_bytes)
assert manifest["protocols"] == {"escape": 1, "leash": 2, "resource": 2}
assert 0 < len(manifest["files"]) <= 128
report = {"origin": ORIGIN, "verifiedAt": datetime.now(timezone.utc).isoformat(),
          "sourceRevision": manifest["resourceProtocol"]["sourceRevision"],
          "version": manifest["version"], "files": [], "wasmNegotiation": []}


def sha256(data):
    return hashlib.sha256(data).hexdigest()


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise AssertionError("Static release unexpectedly redirected")


opener = urllib.request.build_opener(NoRedirect)


def request(path, maximum, encoding="identity", method="GET", status=200):
    assert path.startswith("/") and "#" not in path and ".." not in path
    req = urllib.request.Request(ORIGIN + path, method=method, headers={
        "Accept-Encoding": encoding, "User-Agent": "TailMouse-resource-release-verifier/1"})
    try:
        response = opener.open(req, timeout=45)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        assert response.status == status, (path, response.status, status)
        data = response.read(maximum + 1)
        assert len(data) <= maximum, path
        for name, value in {"Referrer-Policy": "no-referrer",
                            "X-Content-Type-Options": "nosniff",
                            "Origin-Agent-Cluster": "?1"}.items():
            assert response.headers.get(name) == value, (path, name)
        return data, response.headers


public_manifest, _ = request("/web-manifest.json", len(manifest_bytes))
assert public_manifest == manifest_bytes
report["manifestSha256"] = sha256(public_manifest)
config, config_headers = request("/tailmouse-config.json", 4096)
assert json.loads(config) == {
    "version": 1, "frontendBase": ORIGIN, "contentBase": ORIGIN,
    "testSingleOrigin": True, "releaseManifest": "/web-manifest.json"}
assert config_headers["Cache-Control"] == "no-store"
report["configuration"] = "verified private single-origin mode"

for name, metadata in manifest["files"].items():
    data, headers = request("/" + name, metadata["bytes"],
                            metadata.get("contentEncoding", "identity"))
    assert len(data) == metadata["bytes"] and sha256(data) == metadata["sha256"], name
    assert headers.get("Content-Type") == metadata["contentType"], (name, "MIME")
    assert headers.get("Content-Encoding") == metadata.get("contentEncoding"), (name, "encoding")
    cache = "public, max-age=31536000, immutable" if name.startswith(("assets/", "tailcat/")) else "no-store"
    assert headers.get("Cache-Control") == cache, (name, "cache")
    report["files"].append({"path": name, "bytes": len(data), "sha256": sha256(data)})
    if name.endswith(".wasm"):
        for encoding, suffix in (("br", ".br"), ("gzip", ".gz")):
            encoded = manifest["files"][name + suffix]
            data, headers = request("/" + name, encoded["bytes"], encoding)
            assert sha256(data) == encoded["sha256"] and len(data) == encoded["bytes"], name
            assert headers.get("Content-Encoding") == encoding
            assert "Accept-Encoding" in headers.get("Vary", "")
            report["wasmNegotiation"].append({"path": name, "encoding": encoding, "sha256": sha256(data)})

for route, source in (("/", "index.html"), ("/.tailmouse/workspace/", "index.html"),
                      ("/.tailmouse/p/" + "a" * 32 + "/bridge.html", ".tailmouse/bridge.html")):
    metadata = manifest["files"][source]
    data, headers = request(route + "?release-verification=1", metadata["bytes"])
    assert sha256(data) == metadata["sha256"]
    assert headers["Cache-Control"] == "no-store"
    frame = "frame-ancestors 'self'" if source.endswith("bridge.html") else "frame-ancestors 'none'"
    assert frame in headers["Content-Security-Policy"]
    head, _ = request(route, 0, method="HEAD")
    assert head == b""
_, headers = request("/.tailmouse/sw.js", manifest["files"][".tailmouse/sw.js"]["bytes"])
assert headers["Service-Worker-Allowed"] == "/.tailmouse/p/"
request("/release-verification-missing", 65536, status=404)
request("/release-verification-business", 0, method="POST", status=405)
report["routesAndHeaders"] = "verified"
report["status"] = "verified"
Path(sys.argv[2]).write_text(json.dumps(report, indent=2) + "\n")
print(json.dumps({key: value for key, value in report.items() if key not in ("files", "wasmNegotiation")}))
print("Verified", len(report["files"]), "asset representations and both Wasm negotiation paths.")
