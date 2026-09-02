import preact from '@preact/preset-vite';
import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const tailcatArtifacts = resolve(
  import.meta.dirname,
  '../../.artifacts/tailcat',
);
const tailcatFiles = [
  'manifest.json',
  'tailcat-web.wasm',
  'wasm_exec.js',
] as const;

export default defineConfig({
  base: './',
  build: {
    assetsInlineLimit: 0,
    sourcemap: true,
  },
  plugins: [
    {
      name: 'tailmouse-tailcat-artifacts',
      apply: 'build',
      buildStart() {
        for (const file of tailcatFiles) {
          this.emitFile({
            fileName: `tailcat/${file}`,
            source: readFileSync(resolve(tailcatArtifacts, file)),
            type: 'asset',
          });
        }
      },
    },
    preact(),
  ],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
});
