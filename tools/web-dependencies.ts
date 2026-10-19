import { readFileSync } from 'node:fs';
import { join } from 'node:path';

interface ModuleIdentity {
  name: string;
  version: string;
}

const moduleVersion =
  /^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const npmVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const tailcatModule = 'github.com/tailscale/tailcat';

export function wasmBuildTags(source: Buffer, revision: string): string {
  wasmDependencies(source, revision);
  const tag = /build\t-tags=([a-z0-9_,]+)\n/u.exec(
    source.toString('latin1'),
  )?.[1];
  if (
    !tag ||
    !tag.split(',').includes('ts_omit_udptransport') ||
    !tag.split(',').includes('ts_omit_nattraversal') ||
    tag.split(',').includes('ts_omit_netstack')
  )
    throw new Error(
      'Verified upstream Wasm build tags are missing or incompatible.',
    );
  return tag;
}

// Go's linker embeds runtime.modinfo between these markers, including in
// Wasm. The standard go version -m reader does not support the Wasm format.
// Emit only module identities and validate required unquoted settings; never
// emit linker flags. Reject an unfamiliar format instead of guessing dependencies.
// Source: go.dev/src/cmd/go/internal/modload/build.go (Go 1.27.1).
interface ResourceSource {
  revision: string;
  sourceSha256: string;
  tailcatVersion: string;
}
export function wasmDependencies(source: Buffer, revision: string) {
  return readWasmDependencies(source, revision);
}
export function resourceWasmDependencies(
  source: Buffer,
  tailcatRevision: string,
  provenance: ResourceSource,
) {
  if (
    !/^[a-f0-9]{40}$/u.test(provenance.revision) ||
    !/^[a-f0-9]{64}$/u.test(provenance.sourceSha256) ||
    !moduleVersion.test(provenance.tailcatVersion)
  )
    throw new Error('Resource Wasm source identity is invalid.');
  const inventory = readWasmDependencies(source, tailcatRevision, provenance);
  return {
    ...inventory,
    sourceSha256: provenance.sourceSha256,
    tailcat: {
      name: tailcatModule,
      version: provenance.tailcatVersion,
      revision: tailcatRevision,
    },
  };
}
function readWasmDependencies(
  source: Buffer,
  revision: string,
  resource?: ResourceSource,
) {
  const start = Buffer.from('3077af0c9274080241e1c107e6d618e6', 'hex');
  const end = Buffer.from('f932433186182072008242104116d8f2', 'hex');
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  if (
    !source.subarray(0, 8).equals(Buffer.from('0061736d01000000', 'hex')) ||
    !/^[a-f0-9]{40}$/u.test(revision) ||
    first < 8 ||
    last < first + start.length ||
    last - first > 64 * 1024 ||
    source.indexOf(start, first + 1) !== -1 ||
    source.indexOf(end) !== last ||
    source.indexOf(end, last + 1) !== -1
  )
    throw new Error('Wasm has missing, ambiguous or oversized Go build info.');
  const raw = source.subarray(first + start.length, last);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  if (!text.endsWith('\n')) throw new Error('Wasm Go build info is truncated.');

  let path: string | undefined;
  let main: ModuleIdentity | undefined;
  const modules: (ModuleIdentity & { sum: string })[] = [];
  const names = new Set<string>();
  const settings = new Map<string, string>();
  let hasPinnedTailcat = false;
  for (const line of text.slice(0, -1).split('\n')) {
    const [kind, name, version, sum, ...extra] = line.split('\t');
    if (kind === 'path' && name && version === undefined && !path) {
      path = name;
    } else if (kind === 'mod' || kind === 'dep') {
      if (
        resource !== undefined &&
        kind === 'dep' &&
        name === tailcatModule &&
        version === '(devel)' &&
        sum === '' &&
        extra.length === 0 &&
        !names.has(name)
      ) {
        names.add(name);
        hasPinnedTailcat = true;
        continue;
      }
      if (
        !name ||
        !/^[\w][\w./~+-]*$/u.test(name) ||
        !version ||
        !moduleVersion.test(version) ||
        sum === undefined ||
        extra.length !== 0 ||
        names.has(name)
      )
        throw new Error('Wasm has invalid or duplicate Go module identity.');
      names.add(name);
      if (kind === 'mod') {
        if (
          main ||
          name !== (resource === undefined ? tailcatModule : 'tailmouse') ||
          sum !== ''
        )
          throw new Error('Wasm has an unexpected main module.');
        main = { name, version };
      } else {
        if (!/^h1:[A-Za-z0-9+/]{43}=$/u.test(sum))
          throw new Error('Wasm Go dependency has no immutable checksum.');
        modules.push({ name, version, sum });
      }
    } else if (kind === 'build' && name && version === undefined) {
      const equals = name.indexOf('=');
      const key = name.slice(0, equals);
      if (equals < 1 || settings.has(key))
        throw new Error('Wasm has invalid or duplicate Go build settings.');
      settings.set(key, name.slice(equals + 1));
    } else {
      // Local/module replacements need an explicit source-identity design.
      throw new Error('Wasm has an unsupported Go build-info record.');
    }
  }
  if (
    path !==
      (resource === undefined
        ? `${tailcatModule}/web`
        : 'tailmouse/apps/cli/internal/transport/tailcat/wasm') ||
    !main ||
    modules.length === 0 ||
    settings.get('GOOS') !== 'js' ||
    settings.get('GOARCH') !== 'wasm' ||
    settings.get('CGO_ENABLED') !== '0' ||
    settings.get('vcs.revision') !== (resource?.revision ?? revision) ||
    (resource === undefined
      ? settings.get('vcs.modified') !== 'false'
      : !hasPinnedTailcat ||
        !['true', 'false'].includes(settings.get('vcs.modified') ?? ''))
  )
    throw new Error('Wasm build identity does not match the clean gitlink.');
  if (settings.get('-trimpath') !== 'true')
    throw new Error('Wasm requires trimmed source paths.');
  return {
    main: { ...main, revision: resource?.revision ?? revision },
    modules: modules.sort((a, b) => a.name.localeCompare(b.name, 'en')),
  };
}

// OutputChunk.modules is the bundler's included-module inventory. Derive
// package roots from resolved node_modules paths, not the root lockfile,
// which also contains unshipped build and test tools. Never emit local paths.
export function npmDependencies(
  moduleIDs: Iterable<string>,
  viteVersion?: string,
) {
  const packages = new Map<string, ModuleIdentity>();
  const roots = new Set<string>();
  for (const moduleID of moduleIDs) {
    if (moduleID.includes('\0')) {
      // Vite injects runtime helpers (for example modulepreload). Their
      // source package belongs in the shipped inventory despite being a
      // development dependency. Unrecognized virtual producers fail closed.
      if (
        !moduleID.startsWith('\0vite/') ||
        !viteVersion ||
        !npmVersion.test(viteVersion)
      )
        throw new Error('Bundled virtual dependency has no known producer.');
      packages.set(`vite@${viteVersion}`, {
        name: 'vite',
        version: viteVersion,
      });
      continue;
    }
    const id = moduleID.replaceAll('\\', '/');
    const marker = '/node_modules/';
    const offset = id.lastIndexOf(marker);
    if (offset < 0) continue;
    const relative = id.slice(offset + marker.length);
    const match = /^(?<name>@[\w.-]+\/[\w.-]+|[\w.-]+)\//u.exec(relative);
    const name = match?.groups?.name;
    if (!name || name.startsWith('.'))
      throw new Error('Bundled dependency has an unsupported package path.');
    const root = id.slice(0, offset + marker.length) + name;
    if (roots.has(root)) continue;
    const manifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { name?: unknown; version?: unknown };
    if (
      manifest.name !== name ||
      typeof manifest.version !== 'string' ||
      !npmVersion.test(manifest.version)
    )
      throw new Error('Bundled dependency has an invalid package identity.');
    roots.add(root);
    const identity = { name, version: manifest.version };
    packages.set(`${identity.name}@${identity.version}`, identity);
  }
  if (packages.size === 0)
    throw new Error('Web bundle has no recorded npm dependencies.');
  return [...packages.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`, 'en'),
  );
}
