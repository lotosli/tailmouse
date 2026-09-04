import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertNoCredentials } from './sbom.ts';

export interface NoticeLibrary {
  ecosystem: 'golang' | 'npm';
  name: string;
  version: string;
  revision?: string;
  scope: 'distribution' | 'source-skills';
  files: { name: string; source: Buffer }[];
}

const hash = (source: Buffer) =>
  createHash('sha256').update(source).digest('hex');

export function thirdPartyNotices(libraries: NoticeLibrary[]) {
  assert.ok(
    libraries.length > 0 && libraries.length <= 128,
    'Invalid notice inventory size.',
  );
  const keys = libraries.map(
    (item) => `${item.ecosystem}:${item.name}@${item.version}`,
  );
  assert.equal(new Set(keys).size, keys.length, 'Duplicate notice library.');
  const text = [
    'TailMouse third-party notices\n\n',
    'This bundle preserves notices from the exact dependency sources used by the native and Web distributions. Nested source-subtree notices are conservatively included and do not imply that every subcomponent is linked. Source-only OpenSpec skill attribution is identified separately. Third-party terms apply to their respective software, not to TailMouse-owned source.\n\n',
    'The complete Apache License 2.0 text accompanies this file as LICENSE.\n',
  ];
  let count = 0;
  const entries = [...libraries]
    .sort((a, b) =>
      `${a.ecosystem}:${a.name}@${a.version}`.localeCompare(
        `${b.ecosystem}:${b.name}@${b.version}`,
        'en',
      ),
    )
    .map((library) => {
      assert.match(
        library.name,
        /^(?:@[\w.-]+\/)?[\w][\w./~+-]*$/u,
        'Invalid notice library name.',
      );
      assert.match(
        library.version,
        /^(?:go|v)?\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/u,
        'Invalid notice version.',
      );
      assert.ok(
        ['golang', 'npm'].includes(library.ecosystem),
        'Invalid notice ecosystem.',
      );
      assert.ok(
        ['distribution', 'source-skills'].includes(library.scope),
        'Invalid notice scope.',
      );
      if (library.revision !== undefined)
        assert.match(
          library.revision,
          /^[a-f0-9]{40}$/u,
          'Invalid notice revision.',
        );
      assert.ok(
        library.files.some((file) =>
          /^(?:licen[cs]e|copying)(?:[._-]|$)/iu.test(file.name),
        ),
        'Dependency has no root license grant.',
      );
      assert.equal(
        new Set(library.files.map((file) => file.name)).size,
        library.files.length,
        'Duplicate source notice.',
      );
      text.push(
        `\n=== ${library.ecosystem}:${library.name}@${library.version} (${library.scope}) ===\n`,
      );
      if (library.revision) text.push(`Source revision: ${library.revision}\n`);
      const files = [...library.files]
        .sort((a, b) => a.name.localeCompare(b.name, 'en'))
        .map(({ name, source }) => {
          assert.ok(++count <= 512, 'Too many source notices.');
          assert.ok(
            name.length <= 512 &&
              name
                .split('/')
                .every(
                  (part) =>
                    /^[\w.+-]+$/u.test(part) && part !== '.' && part !== '..',
                ),
            'Unsafe source notice path.',
          );
          assert.ok(
            source.length > 0 && source.length <= 2 * 1024 * 1024,
            'Invalid source notice size.',
          );
          assertNoCredentials(source);
          const content = new TextDecoder('utf-8', {
            fatal: true,
            ignoreBOM: true,
          }).decode(source);
          assert.ok(!content.includes('\0'), 'Binary source notice.');
          text.push(`\n--- ${name} ---\n`, content, '\n');
          return { name, bytes: source.length, sha256: hash(source) };
        });
      const { files: _files, ...identity } = library;
      return { ...identity, files };
    });
  const source = Buffer.from(text.join(''));
  assert.ok(
    source.length <= 8 * 1024 * 1024,
    'Notice bundle exceeds its bound.',
  );
  return {
    source,
    inventory: {
      schemaVersion: 1,
      noticeSha256: hash(source),
      libraries: entries,
    },
  };
}

export function distributionNotices(root: string) {
  const result = projectNotices(root);
  const fileName = 'THIRD_PARTY_NOTICES.txt';
  const path = resolve(root, fileName);
  const stat = lstatSync(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink() && stat.size <= 8 * 1024 * 1024,
    'Invalid third-party notice file.',
  );
  const source = readFileSync(path);
  assertNoCredentials(source);
  const inventory = JSON.parse(
    readFileSync(resolve(root, 'tooling/third-party-licenses.json'), 'utf8'),
  ) as { schemaVersion: unknown; noticeSha256: unknown };
  assert.equal(inventory.schemaVersion, 1, 'Unsupported notice inventory.');
  assert.equal(
    hash(source),
    inventory.noticeSha256,
    'Third-party notice content differs from its inventory.',
  );
  return [...result, { fileName, source }];
}

export function verifyNoticeCoverage(
  inventory: ReturnType<typeof thirdPartyNotices>['inventory'],
  components: {
    name: string;
    version?: string;
    purl?: string;
    properties?: { name: string; value: string }[];
  }[],
) {
  assert.equal(inventory.schemaVersion, 1, 'Unsupported notice inventory.');
  const expected = new Map(
    inventory.libraries
      .filter((item) => item.scope === 'distribution')
      .map((item) => [
        `pkg:${item.ecosystem}:${item.name}@${item.version}`,
        item,
      ]),
  );
  const actual = new Set<string>();
  for (const component of components) {
    const ecosystem = /^(pkg:(?:golang|npm))\//u.exec(
      component.purl ?? '',
    )?.[1];
    assert.ok(ecosystem, 'Artifact has no supported dependency ecosystem.');
    const key = `${ecosystem}:${component.name}@${component.version}`;
    const source = expected.get(key);
    assert.ok(source, 'Artifact dependency is absent from notice inventory.');
    if (source.revision)
      assert.equal(
        component.properties?.find(
          (item) => item.name === 'tailmouse:git-revision',
        )?.value,
        source.revision,
        'Artifact notice revision differs.',
      );
    actual.add(key);
  }
  assert.deepEqual(
    [...actual].sort(),
    [...expected.keys()].sort(),
    'Notice inventory differs from distributed dependencies.',
  );
}

// Complete standard text from https://www.apache.org/licenses/LICENSE-2.0.txt.
const apache2 =
  'cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30';

export function projectNotices(root: string) {
  return ['LICENSE', 'NOTICE'].map((fileName) => {
    const path = resolve(root, fileName);
    const stat = lstatSync(path);
    assert.ok(
      stat.isFile() && !stat.isSymbolicLink() && stat.size <= 65536,
      'Project notice must be a bounded regular file.',
    );
    const source = readFileSync(path);
    assertNoCredentials(source);
    if (fileName === 'LICENSE')
      assert.equal(
        createHash('sha256').update(source).digest('hex'),
        apache2,
        'Project license differs from the complete Apache-2.0 text.',
      );
    else
      assert.match(
        source.toString('utf8'),
        /^TailMouse\nCopyright 2026 TailMouse contributors\n\nTailMouse-owned source is licensed under the Apache License, Version 2\.0\.\nThird-party software retains its own copyright notices and license terms\.\n$/u,
        'Project NOTICE differs from the accepted attribution.',
      );
    return { fileName, source };
  });
}
