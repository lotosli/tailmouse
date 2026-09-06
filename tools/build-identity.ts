import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface BuildIdentity {
  readonly version: string;
  readonly tailcatRevision: string;
  readonly protocols: Readonly<{
    readonly escape: 1;
    readonly leash: 2;
  }>;
}

export function buildIdentity(
  root: string,
  releaseVersion?: string,
): BuildIdentity {
  const git = (...args: string[]): string => {
    try {
      return execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }).trim();
    } catch {
      throw new Error('Build identity requires readable Git metadata.');
    }
  };
  const entry = git('ls-files', '--stage', '--', 'third_party/tailcat');
  const tailcatRevision =
    /^160000 ([0-9a-f]{40}) 0\tthird_party\/tailcat$/u.exec(entry)?.[1];
  if (
    tailcatRevision === undefined ||
    git('-C', 'third_party/tailcat', 'rev-parse', 'HEAD') !== tailcatRevision ||
    git('-C', 'third_party/tailcat', 'status', '--porcelain=v1') !== ''
  ) {
    throw new Error(
      'Build identity requires the clean recorded Tailcat gitlink.',
    );
  }
  let version = releaseVersion;
  const dirty = git('status', '--porcelain=v1') !== '';
  if (releaseVersion !== undefined && dirty)
    throw new Error('Release builds require clean TailMouse sources.');
  if (version === undefined) {
    const manifest = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { version?: unknown };
    if (typeof manifest.version !== 'string')
      throw new Error('Project version is missing.');
    version = `${manifest.version}-dev.${git('rev-parse', 'HEAD').slice(0, 12)}${dirty ? '.dirty' : ''}`;
  }
  if (
    version.length > 32 ||
    !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    throw new Error('Build version must be a bounded semantic version.');
  }
  return Object.freeze({
    version,
    tailcatRevision,
    protocols: Object.freeze({ escape: 1, leash: 2 }),
  });
}
