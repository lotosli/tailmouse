# Homepage width and public download entry

Observed on 2026-10-19: the homepage heading had two explicit breaks, and separate hero/description width limits left much of a wide page unused. The fix removes the internal limits, expands the page to 1440 pixels and lets the two heading sentences wrap naturally within their own blocks. It also exposes the published native preview and current source instructions.

[Validation](validation.json) binds the complete Linux gate to the layout source before the final download-copy update. The final copy/link change passes the seven existing workspace browser tests and Web typechecking. [Local layout measurements](local-layout.json) cover five widths from 390 through 2700 pixels, without horizontal overflow. At desktop widths each heading sentence and the description fit on one line.

Publication of this homepage is pending a clean committed build and public verification. The separately published [native preview](../native-release-v0.1.0-alpha.1/README.md) remains immutable. The four representative network profiles, Escape game, pinned Tailcat source and trusted-app same-origin configuration are unchanged.
