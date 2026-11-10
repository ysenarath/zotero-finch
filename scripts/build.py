#!/usr/bin/env python3
"""Package Finch as an installable .xpi.

    python3 scripts/build.py                          # build/zotero-finch-<version>.xpi
    python3 scripts/build.py --bump patch             # bump manifest version first (major|minor|patch)
    python3 scripts/build.py --update-base URL        # self-hosting: .xpi and updates.json both live at URL

Also writes build/updates.json. By default it targets GitHub releases: the manifest's update_url is
<homepage>/releases/latest/download/updates.json and each update_link is
<homepage>/releases/download/v<version>/<xpi>, so upload both files as assets of release v<version>.
"""
import argparse
import hashlib
import json
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "addon"
OUT = ROOT / "build"
SKIP = {".DS_Store"}


def bump(version, part):
    major, minor, patch = (int(x) for x in version.split("."))
    if part == "major":
        return f"{major + 1}.0.0"
    if part == "minor":
        return f"{major}.{minor + 1}.0"
    return f"{major}.{minor}.{patch + 1}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--bump", choices=["major", "minor", "patch"])
    ap.add_argument("--update-base", help="https base URL where the .xpi and updates.json will be hosted")
    args = ap.parse_args()

    manifest_path = SRC / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    if args.bump:
        manifest["version"] = bump(manifest["version"], args.bump)
        manifest_path.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n")
        print("version →", manifest["version"])

    version = manifest["version"]
    addon_id = manifest["applications"]["zotero"]["id"]
    xpi_name = f"zotero-finch-{version}.xpi"

    packaged = json.loads(json.dumps(manifest))
    if args.update_base:
        base = args.update_base.rstrip("/")
        if not base.startswith("https://"):
            raise SystemExit("--update-base must be an https URL")
        packaged["applications"]["zotero"]["update_url"] = f"{base}/updates.json"

    OUT.mkdir(exist_ok=True)
    xpi = OUT / xpi_name
    with zipfile.ZipFile(xpi, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("manifest.json", json.dumps(packaged, indent=2, ensure_ascii=False) + "\n")
        for f in sorted(SRC.rglob("*")):
            rel = f.relative_to(SRC).as_posix()
            if f.is_dir() or f.name in SKIP or rel == "manifest.json":
                continue
            z.write(f, rel)
    print("built", xpi.relative_to(ROOT), f"({xpi.stat().st_size // 1024} KB)")

    if args.update_base:
        link = f"{base}/{xpi_name}"
    else:
        link = f"{manifest['homepage_url'].rstrip('/')}/releases/download/v{version}/{xpi_name}"
    sha = hashlib.sha256(xpi.read_bytes()).hexdigest()
    z_app = manifest["applications"]["zotero"]
    updates = {
        "addons": {
            addon_id: {
                "updates": [
                    {
                        "version": version,
                        "update_link": link,
                        "update_hash": f"sha256:{sha}",
                        "applications": {
                            "zotero": {
                                "strict_min_version": z_app["strict_min_version"],
                                "strict_max_version": z_app["strict_max_version"],
                            }
                        },
                    }
                ]
            }
        }
    }
    (OUT / "updates.json").write_text(json.dumps(updates, indent=2) + "\n")
    print("wrote build/updates.json")


if __name__ == "__main__":
    main()
