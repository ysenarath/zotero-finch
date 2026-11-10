# Finch

An AI research companion for Zotero, powered by Claude Code. Chat beside your papers, get explanations of passages in the PDF reader, and review library edits before they're applied.

Documentation is coming soon.

## Install

Requires Zotero 7 or later and the [Claude Code](https://claude.com/claude-code) CLI.

Download the latest `.xpi` from [Releases](https://github.com/ysenarath/zotero-finch/releases), then in Zotero choose **Tools → Plugins**, click the gear icon and select **Install Plugin From File…**.

## Build

```sh
uv run scripts/build.py   # → build/zotero-finch-<version>.xpi and build/updates.json
```

## License

See [LICENSE](LICENSE).

Finch is an independent project and isn't affiliated with or endorsed by Anthropic or the Corporation for Digital Scholarship. Claude and Claude Code are trademarks of Anthropic. Zotero is a trademark of the Corporation for Digital Scholarship.
