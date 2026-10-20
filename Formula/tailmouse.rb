class Tailmouse < Formula
  desc "Share files, text, terminals and web apps with a browser"
  homepage "https://tailmouse.com"
  version "0.1.0-alpha.3"
  license "Apache-2.0"

  on_macos do
    on_intel do
      url "https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.3/tailmouse_0.1.0-alpha.3_darwin_amd64.tar.gz"
      sha256 "55c4a3bca06f3431dc0bfd18f87b2510fdba0bd12df2702b7425c83eb10012be"
    end
    on_arm do
      url "https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.3/tailmouse_0.1.0-alpha.3_darwin_arm64.tar.gz"
      sha256 "6f06e799de8b5e1e0d3b223f94f70069e010661bb95e6c6fbe16de9b9a638fe9"
    end
  end
  on_linux do
    on_intel do
      url "https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.3/tailmouse_0.1.0-alpha.3_linux_amd64.tar.gz"
      sha256 "57a65f3aa3e94c8c4b6583d2d99626a36ffee95a0afed4f4e49d506f55edcf5c"
    end
    on_arm do
      url "https://github.com/lotosli/tailmouse/releases/download/v0.1.0-alpha.3/tailmouse_0.1.0-alpha.3_linux_arm64.tar.gz"
      sha256 "de341193375afb94f1d0517bab70ed413fd4d576109ac4ec945dea2790d6467f"
    end
  end

  def install
    bin.install "tailmouse"
    doc.install "README.md"
  end

  test do
    assert_match "TailMouse 0.1.0-alpha.3", shell_output("#{bin}/tailmouse version")
  end
end
