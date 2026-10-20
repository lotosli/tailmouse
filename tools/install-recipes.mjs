import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function installRecipes(manifest) {
  const version = manifest.version;
  assert.match(version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u);
  assert.equal(manifest.tag, `v${version}`);
  const base = `https://github.com/lotosli/tailmouse/releases/download/v${version}`;
  function artifact(os, arch) {
    const name = `tailmouse_${version}_${os}_${arch}.${os === 'windows' ? 'zip' : 'tar.gz'}`;
    const matches = manifest.files.filter((file) => file.name === name);
    assert.equal(matches.length, 1);
    assert.match(matches[0].sha256, /^[a-f0-9]{64}$/u);
    return { url: `${base}/${name}`, hash: matches[0].sha256 };
  }
  const macIntel = artifact('darwin', 'amd64');
  const macArm = artifact('darwin', 'arm64');
  const linuxIntel = artifact('linux', 'amd64');
  const linuxArm = artifact('linux', 'arm64');
  const windowsIntel = artifact('windows', 'amd64');
  const windowsArm = artifact('windows', 'arm64');
  const formula = `class Tailmouse < Formula
  desc "Share files, text, terminals and web apps with a browser"
  homepage "https://tailmouse.com"
  version "${version}"
  license "Apache-2.0"

  on_macos do
    on_intel do
      url "${macIntel.url}"
      sha256 "${macIntel.hash}"
    end
    on_arm do
      url "${macArm.url}"
      sha256 "${macArm.hash}"
    end
  end
  on_linux do
    on_intel do
      url "${linuxIntel.url}"
      sha256 "${linuxIntel.hash}"
    end
    on_arm do
      url "${linuxArm.url}"
      sha256 "${linuxArm.hash}"
    end
  end

  def install
    bin.install "tailmouse"
    doc.install "README.md"
  end

  test do
    assert_match "TailMouse ${version}", shell_output("#{bin}/tailmouse version")
  end
end
`;
  const bucket = {
    version,
    description: 'Share files, text, terminals and web apps with a browser',
    homepage: 'https://tailmouse.com',
    license: 'Apache-2.0',
    architecture: { '64bit': windowsIntel, arm64: windowsArm },
    bin: 'tailmouse.exe',
    checkver: { github: 'https://github.com/lotosli/tailmouse' },
    autoupdate: {
      architecture: Object.fromEntries(
        [
          ['64bit', 'amd64'],
          ['arm64', 'arm64'],
        ].map(([key, arch]) => [
          key,
          {
            url: `https://github.com/lotosli/tailmouse/releases/download/v$version/tailmouse_$version_windows_${arch}.zip`,
            hash: {
              url: 'https://github.com/lotosli/tailmouse/releases/download/v$version/SHA256SUMS',
              regex: `$sha256\\s+tailmouse_$version_windows_${arch}\\.zip`,
            },
          },
        ]),
      ),
    },
  };
  return { formula, bucket };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  assert.equal(
    process.argv.length,
    4,
    'Expected published release manifest and output repository directory.',
  );
  const result = installRecipes(
    JSON.parse(readFileSync(process.argv[2], 'utf8')),
  );
  for (const [path, body] of [
    ['Formula/tailmouse.rb', result.formula],
    ['bucket/tailmouse.json', JSON.stringify(result.bucket, null, 2) + '\n'],
  ]) {
    const target = resolve(process.argv[3], path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  process.stdout.write(
    'Generated checksum-pinned Homebrew and Scoop recipes.\n',
  );
}
