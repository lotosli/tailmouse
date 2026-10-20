class Tailmouse < Formula
  desc "Share files, text, terminals and web apps with a browser"
  homepage "https://tailmouse.com"
  version "1.0.0"
  license "Apache-2.0"

  on_macos do
    on_intel do
      url "https://github.com/lotosli/tailmouse/releases/download/v1.0.0/tailmouse_1.0.0_darwin_amd64.tar.gz"
      sha256 "2ed514cd81cc702dc2907f16bcbeff8e23c550a8dd18d039bfd84316840fdc86"
    end
    on_arm do
      url "https://github.com/lotosli/tailmouse/releases/download/v1.0.0/tailmouse_1.0.0_darwin_arm64.tar.gz"
      sha256 "f4d27e48bc4c54d5b4cfb2a0aa169480d9cff0c3bf73e7b853175e4e5663010f"
    end
  end
  on_linux do
    on_intel do
      url "https://github.com/lotosli/tailmouse/releases/download/v1.0.0/tailmouse_1.0.0_linux_amd64.tar.gz"
      sha256 "ea4195e1a3fd522e2212448f565b1dd52291017d2fed781f9c88d7f2535e9de3"
    end
    on_arm do
      url "https://github.com/lotosli/tailmouse/releases/download/v1.0.0/tailmouse_1.0.0_linux_arm64.tar.gz"
      sha256 "c8100ce8c44e4f5c4989d611a08cd165c696a6636404d352adf339b5a3d8c278"
    end
  end

  def install
    bin.install "tailmouse"
    doc.install "README.md"
  end

  test do
    assert_match "TailMouse 1.0.0", shell_output("#{bin}/tailmouse version")
  end
end
