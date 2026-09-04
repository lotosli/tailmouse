import preact from '@preact/preset-vite';
import {
  defineConfig,
  rolldownVersion,
  transformWithOxc,
  version as viteVersion,
} from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildIdentity } from '../../tools/build-identity.ts';
import { distributionNotices } from '../../tools/release-licenses.ts';
import {
  npmDependencies,
  wasmDependencies,
} from '../../tools/web-dependencies.ts';
import {
  compressedAssets,
  digest,
  securityHeaders,
  tailcatAssets,
  verifyStaticReferences,
} from '../../tools/web-assets.ts';

const tailcatArtifacts = resolve(
  import.meta.dirname,
  '../../.artifacts/tailcat',
);
const identity = buildIdentity(
  resolve(import.meta.dirname, '../..'),
  process.env.TAILMOUSE_BUILD_VERSION,
);
const versions = JSON.parse(
  readFileSync(
    resolve(import.meta.dirname, '../../tooling/versions.json'),
    'utf8',
  ),
) as { go: string };
const tailcatBuild = tailcatAssets(
  tailcatArtifacts,
  identity.tailcatRevision,
  `go${versions.go}`,
);
const artifacts = tailcatBuild.files;

export default defineConfig({
  appType: 'mpa',
  base: './',
  define: {
    __TAILMOUSE_BUILD__: JSON.stringify(identity),
    __TAILMOUSE_TAILCAT_ASSETS__: JSON.stringify({
      runtime: `./${artifacts[0]!.fileName}`,
      wasm: `./${artifacts[1]!.fileName}`,
      wasmBytes: artifacts[1]!.source.byteLength,
    }),
  },
  build: {
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  plugins: [
    {
      name: 'tailmouse-tailcat-artifacts',
      apply: 'build',
      enforce: 'post',
      buildStart() {
        for (const artifact of [
          ...artifacts,
          ...distributionNotices(resolve(import.meta.dirname, '../..')),
        ]) {
          this.emitFile({ ...artifact, type: 'asset' });
        }
      },
      generateBundle: {
        order: 'post',
        async handler(_options, bundle) {
          const dependencies = {
            npm: npmDependencies(
              Object.values(bundle).flatMap((item) =>
                item.type === 'chunk' ? Object.keys(item.modules) : [],
              ),
              viteVersion,
            ),
            wasm: wasmDependencies(
              artifacts[1]!.source,
              identity.tailcatRevision,
            ),
          };
          const toolchains = {
            go: tailcatBuild.goVersion,
            vite: viteVersion,
            rolldown: rolldownVersion,
          };
          const files: Record<string, { bytes: number; sha256: string }> = {};
          const publicManifest = readFileSync(
            resolve(import.meta.dirname, 'public/manifest.webmanifest'),
          );
          files['manifest.webmanifest'] = {
            bytes: publicManifest.byteLength,
            sha256: digest(publicManifest),
          };
          const assets: { path: string; integrity: string }[] = [];
          for (const fileName of Object.keys(bundle).sort()) {
            const item = bundle[fileName]!;
            const source = Buffer.from(
              item.type === 'chunk' ? item.code : item.source,
            );
            const sha256 = digest(source);
            if (fileName.endsWith('.html') || fileName.endsWith('.css'))
              verifyStaticReferences(
                source.toString(),
                fileName.endsWith('.html') ? 'html' : 'css',
              );
            files[fileName] = { bytes: source.byteLength, sha256 };
            if (
              /^(?:assets|tailcat)\/[\w.-]+-[\w-]{8,}\.(?:js|css|wasm|svg|png|webp|woff2)$/u.test(
                fileName,
              )
            ) {
              assets.push({
                path: fileName,
                integrity: `sha256-${Buffer.from(sha256, 'hex').toString('base64')}`,
              });
              for (const compressed of compressedAssets(fileName, source)) {
                files[compressed.fileName] = {
                  bytes: compressed.source.byteLength,
                  sha256: digest(compressed.source),
                };
                this.emitFile({ ...compressed, type: 'asset' });
              }
            }
            if (
              item.type === 'chunk' &&
              [...item.imports, ...item.dynamicImports].some(
                (name) => !Object.hasOwn(bundle, name),
              )
            )
              throw new Error(
                'Web build contains an external executable import.',
              );
          }
          const worker = (
            await transformWithOxc(
              readFileSync(resolve(import.meta.dirname, 'worker.ts'), 'utf8'),
              'worker.ts',
              { lang: 'ts', sourceType: 'script', target: 'es2023' },
            )
          ).code;
          const version = digest(JSON.stringify(assets) + worker);
          const source = `const __TAILMOUSE_STATIC_CACHE__ = ${JSON.stringify({ version, assets })};\n${worker}`;
          files['service-worker.js'] = {
            bytes: Buffer.byteLength(source),
            sha256: digest(source),
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
                  schemaVersion: 1,
                  ...identity,
                  cacheVersion: version,
                  dependencies,
                  toolchains,
                  files,
                },
                null,
                2,
              ) + '\n',
          });
        },
      },
    },
    preact(),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  preview: { headers: securityHeaders },
});
