import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { verifyNativeBuild, verifyNativeMatrix } from './release-native.mjs';

const identity = {
  version: '0.1.0',
  tailcatRevision: 'a'.repeat(40),
};
const revision = 'b'.repeat(40);
const targets = ['darwin', 'linux', 'windows'].flatMap((os) =>
  ['amd64', 'arm64'].map((arch) => ({ os, arch })),
);

function binary(os = 'darwin', arch = 'arm64') {
  return {
    GoVersion: 'go1.27.1',
    Path: 'tailmouse/apps/cli/cmd/tailmouse',
    Main: { Path: 'tailmouse' },
    Deps: [
      {
        Path: 'github.com/tailscale/tailcat',
        Replace: { Path: './third_party/tailcat' },
      },
    ],
    Settings: Object.entries({
      GOOS: os,
      GOARCH: arch,
      CGO_ENABLED: '0',
      '-trimpath': 'true',
      'vcs.revision': revision,
    }).map(([Key, Value]) => ({ Key, Value })),
  };
}

await test('native inspection admits exactly the requested six targets with source, Go and dependency identity', () => {
  for (const { os, arch } of targets) {
    verifyNativeBuild(
      binary(os, arch),
      Buffer.from(`${identity.version}\0${identity.tailcatRevision}`),
      identity,
      `${os}/${arch}`,
      revision,
      '1.27.1',
    );
  }
});

await test('native inspection rejects wrong executable, toolchain, target, source, dynamic build or dependency', () => {
  const bytes = Buffer.from(`${identity.version}\0${identity.tailcatRevision}`);
  const verify = (info: ReturnType<typeof binary>, target = 'darwin/arm64') =>
    verifyNativeBuild(info, bytes, identity, target, revision, '1.27.1');
  for (const change of [
    { GoVersion: 'go1.26.0' },
    { Path: 'another/command' },
    { Main: { Path: 'another' } },
    { Deps: [] },
    {
      Deps: [
        {
          Path: 'github.com/tailscale/tailcat',
          Replace: { Path: '/unrecorded/tailcat' },
        },
      ],
    },
  ]) {
    assert.throws(() => verify({ ...binary(), ...change }));
  }
  for (const Key of [
    'GOOS',
    'GOARCH',
    'CGO_ENABLED',
    '-trimpath',
    'vcs.revision',
  ]) {
    const info = binary();
    const setting = info.Settings.find((item) => item.Key === Key)!;
    setting.Value = 'wrong';
    assert.throws(() => verify(info));
    info.Settings = info.Settings.filter((item) => item.Key !== Key);
    assert.throws(() => verify(info));
  }
  assert.throws(() => verify(binary(), 'freebsd/arm64'));
  assert.throws(() => verify(binary(), 'linux/arm64'));
});

await test('trimmed metadata alone cannot pass without both embedded version stamps', () => {
  for (const bytes of [
    Buffer.alloc(0),
    Buffer.from(identity.version),
    Buffer.from(identity.tailcatRevision),
  ]) {
    assert.throws(
      () =>
        verifyNativeBuild(
          binary(),
          bytes,
          identity,
          'darwin/arm64',
          revision,
          '1.27.1',
        ),
      /Missing .* stamp/u,
    );
  }
});

function artifacts() {
  return targets.flatMap(({ os, arch }) => {
    const name = os === 'windows' ? 'tailmouse.exe' : 'tailmouse';
    return [
      {
        type: 'Binary',
        goos: os,
        goarch: arch,
        name,
        extra: { Binaries: [name] },
      },
      {
        type: 'Archive',
        goos: os,
        goarch: arch,
        name: `tailmouse_${identity.version}_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`,
        extra: { Binaries: [name] },
      },
    ];
  });
}

await test('archive matrix requires all six unique single-executable archives with platform-specific names', () => {
  verifyNativeMatrix(artifacts(), identity.version);
  for (const type of ['Binary', 'Archive']) {
    const missing = artifacts();
    missing.splice(
      missing.findIndex((item) => item.type === type),
      1,
    );
    assert.throws(
      () => verifyNativeMatrix(missing, identity.version),
      /exactly one/u,
    );
    const duplicate = artifacts();
    duplicate.push(duplicate.find((item) => item.type === type)!);
    assert.throws(
      () => verifyNativeMatrix(duplicate, identity.version),
      /exactly one/u,
    );
    const wrongName = artifacts();
    wrongName.find((item) => item.type === type)!.name = 'wrong';
    assert.throws(
      () => verifyNativeMatrix(wrongName, identity.version),
      /Unexpected .* name/u,
    );
  }
  const additional = artifacts();
  additional
    .find((item) => item.type === 'Archive')!
    .extra.Binaries.push('tailcat');
  assert.throws(
    () => verifyNativeMatrix(additional, identity.version),
    /one executable/u,
  );
  const empty = artifacts();
  empty.find((item) => item.type === 'Archive')!.extra.Binaries = [];
  assert.throws(
    () => verifyNativeMatrix(empty, identity.version),
    /one executable/u,
  );
  assert.throws(
    () => verifyNativeMatrix(artifacts(), '0.2.0'),
    /Unexpected archive name/u,
  );
});
