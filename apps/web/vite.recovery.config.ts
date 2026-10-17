// Explicit browser recovery build. This does not replace the native/source
// release gate or assert that the missing Go/Wasm sources were reproduced.
import preact from '@preact/preset-vite';
import { defineConfig, transformWithOxc } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  compressedAssets,
  digest,
  webObjectMetadata,
} from '../../tools/web-assets.ts';

const root = resolve(import.meta.dirname, '../..');
const artifacts = resolve(root, '.artifacts/deployed-web-2026-10-17');
const raw = readFileSync(
  resolve(root, 'docs/evidence/web-recovery-2026-10-17/deployed-manifest.json'),
);
const baselineSHA =
  '6ab99ac1aeb6e499c1b3fb00d786a4ac14c444e14cfeeaa7a60aadb18e31503e';
if (digest(raw) !== baselineSHA)
  throw new Error('Recovery manifest integrity mismatch.');
const baseline = JSON.parse(raw.toString()) as {
  tailcatRevision: string;
  protocols: { escape: 1; leash: 2; resource: 2 };
  files: Record<
    string,
    {
      bytes: number;
      sha256: string;
      contentType: string;
      cacheControl: string;
      contentEncoding?: string;
    }
  >;
  resourceProtocol: { wasm: string };
};
const sources = Object.entries(baseline.files).map(([fileName, metadata]) => {
  const source = readFileSync(resolve(artifacts, fileName));
  if (source.length !== metadata.bytes || digest(source) !== metadata.sha256)
    throw new Error(`Recovery asset integrity mismatch: ${fileName}`);
  return { fileName, source };
});
const runtime = sources.find((f) =>
  /wasm_exec-.*\.js$/u.test(f.fileName),
)!.fileName;
const legacy = sources.find((f) => /tailcat-web-.*\.wasm$/u.test(f.fileName))!;
const revision = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const dirty =
  execFileSync('git', ['status', '--porcelain'], {
    cwd: root,
    encoding: 'utf8',
  }).trim() !== '';
const identity = {
  version: `web-alpha.${revision.slice(0, 12)}${dirty ? '.dirty' : ''}`,
  tailcatRevision: baseline.tailcatRevision,
  protocols: baseline.protocols,
};

export default defineConfig({
  appType: 'mpa',
  base: '/',
  publicDir: false,
  define: {
    __TAILMOUSE_BUILD__: JSON.stringify(identity),
    __TAILMOUSE_TAILCAT_ASSETS__: JSON.stringify({
      runtime: `/${runtime}`,
      wasm: `/${legacy.fileName}`,
      wasmBytes: legacy.source.length,
    }),
    __TAILMOUSE_RESOURCE_ASSETS__: JSON.stringify({
      runtime: `/${runtime}`,
      wasm: `/${baseline.resourceProtocol.wasm}`,
      bytes: baseline.files[baseline.resourceProtocol.wasm]!.bytes,
    }),
  },
  build: {
    outDir: '../../.artifacts/web-recovery',
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  plugins: [
    preact(),
    {
      name: 'verified-recovery-artifacts',
      buildStart() {
        this.emitFile({
          type: 'asset',
          fileName: 'social-card.png',
          source: readFileSync(
            resolve(import.meta.dirname, 'public/social-card.png'),
          ),
        });
        for (const file of sources) {
          if (!['index.html', 'service-worker.js'].includes(file.fileName))
            this.emitFile({ type: 'asset', ...file });
        }
      },
      generateBundle: {
        order: 'post',
        async handler(_options, bundle) {
          const files: typeof baseline.files = {};
          const cacheAssets: { path: string; integrity: string }[] = [];
          for (const [fileName, item] of Object.entries(bundle)) {
            const source = Buffer.from(
              item.type === 'chunk' ? item.code : item.source,
            );
            files[fileName] = {
              bytes: source.length,
              sha256: digest(source),
              ...webObjectMetadata(fileName),
            };
            if (/^(assets|tailcat)\/.*\.(js|css|wasm)$/u.test(fileName)) {
              cacheAssets.push({
                path: fileName,
                integrity: `sha256-${Buffer.from(digest(source), 'hex').toString('base64')}`,
              });
              for (const compressed of compressedAssets(fileName, source)) {
                if (bundle[compressed.fileName]) continue;
                files[compressed.fileName] = {
                  bytes: compressed.source.length,
                  sha256: digest(compressed.source),
                  ...webObjectMetadata(compressed.fileName),
                };
                this.emitFile({ type: 'asset', ...compressed });
              }
            }
          }
          const worker = (
            await transformWithOxc(
              readFileSync(resolve(import.meta.dirname, 'worker.ts'), 'utf8'),
              'worker.ts',
              { lang: 'ts', sourceType: 'script', target: 'es2023' },
            )
          ).code;
          const cacheVersion = digest(JSON.stringify(cacheAssets) + worker);
          const source = `const __TAILMOUSE_STATIC_CACHE__ = ${JSON.stringify({ version: cacheVersion, assets: cacheAssets })};\n${worker}`;
          files['service-worker.js'] = {
            bytes: Buffer.byteLength(source),
            sha256: digest(source),
            ...webObjectMetadata('service-worker.js'),
          };
          this.emitFile({
            type: 'asset',
            fileName: 'service-worker.js',
            source,
          });
          this.emitFile({
            type: 'asset',
            fileName: 'web-manifest.json',
            source:
              JSON.stringify(
                {
                  ...baseline,
                  ...identity,
                  cacheVersion,
                  files,
                  recovery: {
                    baselineManifestSHA256: baselineSHA,
                    frontendRevision: revision,
                    dirty,
                    nativeSourceRecovered: false,
                    resourceWasmRebuilt: false,
                  },
                },
                null,
                2,
              ) + '\n',
          });
        },
      },
    },
  ],
});
