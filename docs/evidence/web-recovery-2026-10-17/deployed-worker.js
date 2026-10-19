var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// tailmouse-config.test.json
var tailmouse_config_test_default = {
  version: 1,
  frontendBase: "https://tailmouse.com",
  contentBase: "https://tailmouse.com",
  testSingleOrigin: true,
  releaseManifest: "/web-manifest.json"
};

// worker.ts
function selectEncoding(header) {
  if (!header?.trim()) return "identity";
  const weights = /* @__PURE__ */ new Map();
  for (const item of header.toLowerCase().split(",")) {
    const [name, ...parameters] = item.trim().split(";");
    if (!name) continue;
    let weight = 1;
    for (const parameter of parameters) {
      const match = /^\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/u.exec(
        parameter
      );
      weight = match ? Number(match[1]) : 0;
    }
    weights.set(name, weight);
  }
  const choices = ["br", "gzip", "identity"];
  let selected = null;
  let best = 0;
  for (const choice of choices) {
    const weight = weights.get(choice) ?? (choice === "identity" ? weights.get("*") === 0 ? 0 : 1 : weights.get("*") ?? 0);
    if (weight > best) {
      selected = choice;
      best = weight;
    }
  }
  return selected;
}
__name(selectEncoding, "selectEncoding");
var baseHeaders = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), document-domain=()",
  "Origin-Agent-Cluster": "?1"
};
var worker_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!["GET", "HEAD"].includes(request.method))
      return new Response(null, {
        status: 405,
        headers: {
          ...baseHeaders,
          Allow: "GET, HEAD",
          "Cache-Control": "no-store"
        }
      });
    if (url.pathname === "/tailmouse-config.json")
      return new Response(
        request.method === "HEAD" ? null : JSON.stringify(tailmouse_config_test_default),
        {
          headers: {
            ...baseHeaders,
            "Content-Type": "application/json",
            "Cache-Control": "no-store"
          }
        }
      );
    const bridge = /^\/\.tailmouse\/p\/[a-f0-9]{32}\/bridge\.html$/u.test(
      url.pathname
    );
    if (bridge) url.pathname = "/.tailmouse/bridge.html";
    else if (url.pathname === "/" || url.pathname === "/.tailmouse/workspace/")
      url.pathname = "/index.html";
    url.search = "";
    let encoding;
    let decompress = false;
    const wasm = /^\/tailcat\/[\w.-]+\.wasm$/u.test(url.pathname);
    const assetHeaders = new Headers(request.headers);
    if (wasm) {
      const accepted = selectEncoding(
        typeof request.cf?.clientAcceptEncoding === "string" ? request.cf.clientAcceptEncoding : request.headers.get("Accept-Encoding")
      );
      if (accepted === null)
        return new Response(null, {
          status: 406,
          headers: {
            ...baseHeaders,
            "Cache-Control": "no-store",
            Vary: "Accept-Encoding"
          }
        });
      if (accepted === "br") {
        url.pathname += ".br";
        encoding = "br";
      } else {
        url.pathname += ".gz";
        encoding = "gzip";
        decompress = accepted === "identity";
      }
      assetHeaders.delete("Range");
      assetHeaders.delete("If-Range");
      assetHeaders.set("Accept-Encoding", "identity");
    }
    const asset = await env.ASSETS.fetch(
      new Request(url, { method: request.method, headers: assetHeaders })
    );
    const headers = new Headers(asset.headers);
    for (const [key, value] of Object.entries(baseHeaders))
      headers.set(key, value);
    headers.set(
      "Cache-Control",
      (asset.ok || asset.status === 304) && /^\/(assets|tailcat)\//u.test(url.pathname) ? "public, max-age=31536000, immutable, no-transform" : "no-store"
    );
    if (url.pathname.endsWith(".js"))
      headers.set("Content-Type", "text/javascript; charset=utf-8");
    if (url.pathname === "/.tailmouse/sw.js")
      headers.set("Service-Worker-Allowed", "/.tailmouse/p/");
    if (url.pathname === "/index.html")
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https: wss:; frame-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      );
    if (bridge)
      headers.set(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'self'"
      );
    let body = asset.body;
    if (wasm) headers.set("Vary", "Accept-Encoding");
    if (wasm && (asset.ok || asset.status === 304)) {
      headers.set("Content-Type", "application/wasm");
      if (decompress) {
        headers.delete("Content-Encoding");
        headers.delete("Content-Length");
        if (body !== null && request.method !== "HEAD")
          body = body.pipeThrough(new DecompressionStream("gzip"));
      } else if (encoding !== void 0)
        headers.set("Content-Encoding", encoding);
    }
    const options = {
      status: asset.status,
      headers,
      encodeBody: "manual"
    };
    return new Response(request.method === "HEAD" ? null : body, options);
  }
};
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
