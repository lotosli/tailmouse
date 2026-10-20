import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

await test(
  'POSIX installer selects the platform, verifies bytes and preserves existing files on failure',
  { skip: process.platform === 'win32' },
  () => {
    const root = mkdtempSync(join(tmpdir(), 'tailmouse-installer-'));
    try {
      for (const directory of ['stub', 'fixture', 'install'])
        mkdirSync(join(root, directory));
      const binary = '#!/bin/sh\nprintf "TailMouse installer fixture\\n"\n';
      writeFileSync(join(root, 'fixture', 'tailmouse'), binary, {
        mode: 0o755,
      });
      const archive = join(root, 'fixture', 'archive');
      execFileSync('tar', [
        '-czf',
        archive,
        '-C',
        join(root, 'fixture'),
        'tailmouse',
      ]);
      const digest = createHash('sha256')
        .update(readFileSync(archive))
        .digest('hex');
      const name = 'tailmouse_0.1.0-alpha.3_linux_amd64.tar.gz';
      writeFileSync(
        join(root, 'fixture', 'SHA256SUMS'),
        `${digest}  ${name}\n`,
      );
      writeFileSync(
        join(root, 'stub', 'uname'),
        '#!/bin/sh\ncase "$1" in -s) printf "%s\\n" "${TAILMOUSE_TEST_OS:-Linux}";; -m) printf "x86_64\\n";; esac\n',
        { mode: 0o755 },
      );
      writeFileSync(
        join(root, 'stub', 'curl'),
        `#!/bin/sh
set -eu
previous=''
destination=''
source=archive
for argument in "$@"; do
  if [ "$previous" = '-o' ]; then destination=$argument; fi
  case "$argument" in https://github.com/lotosli/tailmouse/releases/download/*/SHA256SUMS) source=SHA256SUMS;; esac
  previous=$argument
done
[ -n "$destination" ]
cp "$TAILMOUSE_INSTALL_FIXTURE/$source" "$destination"
`,
        { mode: 0o755 },
      );
      const environment = {
        ...process.env,
        PATH: join(root, 'stub') + ':' + process.env.PATH,
        TAILMOUSE_INSTALL_FIXTURE: join(root, 'fixture'),
        TAILMOUSE_INSTALL_DIR: join(root, 'install'),
      };
      const installer = resolve('apps/web/public/install.sh');
      const installed = spawnSync('sh', [installer], {
        env: environment,
        encoding: 'utf8',
      });
      assert.equal(installed.status, 0, installed.stderr);
      assert.equal(
        readFileSync(join(root, 'install', 'tailmouse'), 'utf8'),
        binary,
      );
      writeFileSync(join(root, 'install', 'tailmouse'), 'previous');
      writeFileSync(
        join(root, 'fixture', 'SHA256SUMS'),
        `${'0'.repeat(64)}  ${name}\n`,
      );
      const failure = spawnSync('sh', [installer], {
        env: environment,
        encoding: 'utf8',
      });
      assert.notEqual(failure.status, 0);
      assert.match(failure.stderr, /Checksum mismatch/u);
      assert.equal(
        readFileSync(join(root, 'install', 'tailmouse'), 'utf8'),
        'previous',
      );
      assert.deepEqual(readdirSync(join(root, 'install')), ['tailmouse']);
      const unsupported = spawnSync('sh', [installer], {
        env: { ...environment, TAILMOUSE_TEST_OS: 'Other' },
        encoding: 'utf8',
      });
      assert.notEqual(unsupported.status, 0);
      assert.match(unsupported.stderr, /Unsupported system/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
