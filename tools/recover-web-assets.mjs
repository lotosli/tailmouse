// Recover only public immutable assets. The checked-in manifest is the trust
// anchor; native source and native packages cannot be recovered by this tool.
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const raw = await readFile(
  resolve(root, 'docs/evidence/web-recovery-2026-10-17/deployed-manifest.json'),
);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
if (
  sha(raw) !==
  '6ab99ac1aeb6e499c1b3fb00d786a4ac14c444e14cfeeaa7a60aadb18e31503e'
)
  throw new Error('Recovery manifest integrity mismatch.');
const manifest = JSON.parse(raw);
const destination = resolve(root, '.artifacts/deployed-web-2026-10-17');
for (const [name, metadata] of Object.entries(manifest.files)) {
  if (name.startsWith('/') || name.split('/').includes('..'))
    throw new Error('Invalid artifact path.');
  const file = resolve(destination, name);
  let bytes;
  if (['index.html', 'service-worker.js'].includes(name)) {
    bytes = await readFile(
      resolve(root, 'docs/evidence/web-recovery-2026-10-17', name),
    );
  }
  try {
    bytes ??= await readFile(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const response = await fetch(`https://tailmouse.com/${name}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(90_000),
      headers: {
        'User-Agent': 'Mozilla/5.0 TailMouse-Recovery/1',
        'Accept-Encoding': 'identity',
      },
    });
    if (!response.ok)
      throw new Error(`Public recovery asset unavailable: ${name}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (bytes.length !== metadata.bytes || sha(bytes) !== metadata.sha256)
    throw new Error(`Recovery asset integrity mismatch: ${name}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
}
await writeFile(resolve(destination, 'web-manifest.json'), raw);
console.log(
  `Verified ${Object.keys(manifest.files).length} published assets; native source is not included.`,
);
