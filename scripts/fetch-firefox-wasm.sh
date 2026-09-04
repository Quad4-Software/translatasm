#!/usr/bin/env bash
# Fetch Firefox Translations Bergamot WASM (Remote Settings translations-wasm-v2).
# Used for CJK segmentation-capable engine builds. Does not replace npm 0.4.9 by default.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT_DIR="$ROOT/web/vendor/bergamot-firefox"
RS_URL="https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-wasm-v2/records?_limit=50"
ATTACH_BASE="https://firefox-settings-attachments.cdn.mozilla.net/"

mkdir -p "$OUT_DIR"

python3 - <<'PY' "$OUT_DIR" "$RS_URL" "$ATTACH_BASE"
import json, os, sys, urllib.request

out_dir, rs_url, attach_base = sys.argv[1:4]

def fetch(url, dest):
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        print(f"present: {dest}")
        return
    print(f"fetching {url}")
    req = urllib.request.Request(url, headers={"Accept-Encoding": "identity"})
    with urllib.request.urlopen(req) as resp:
        data = resp.read()
    with open(dest, "wb") as f:
        f.write(data)

with urllib.request.urlopen(rs_url) as resp:
    payload = json.load(resp)

records = payload.get("data") or []
# Prefer highest major version bergamot wasm record.
candidates = []
for r in records:
    name = (r.get("name") or r.get("id") or "").lower()
    if "bergamot" in name or r.get("fileType") == "wasm" or "wasm" in name:
        candidates.append(r)
if not candidates:
    candidates = records

if not candidates:
    raise SystemExit("no translations-wasm-v2 records found")

def ver_key(r):
    v = str(r.get("version") or "0")
    parts = []
    for p in v.replace("-", ".").split("."):
        try:
            parts.append(int(p))
        except ValueError:
            parts.append(0)
    return tuple(parts)

candidates.sort(key=ver_key, reverse=True)
rec = candidates[0]
att = rec.get("attachment") or {}
loc = att.get("location")
if not loc:
    meta_path = os.path.join(out_dir, "record.json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(rec, f, indent=2)
        f.write("\n")
    raise SystemExit(f"record missing attachment; wrote {meta_path}")

dest_name = att.get("filename") or "bergamot-translator.wasm"
if not dest_name.endswith(".wasm") and not dest_name.endswith(".zst"):
    dest_name = "bergamot-translator.wasm.zst"
dest = os.path.join(out_dir, dest_name)
fetch(attach_base + loc, dest)

meta_path = os.path.join(out_dir, "record.json")
with open(meta_path, "w", encoding="utf-8") as f:
    json.dump({"record": rec, "local": dest_name}, f, indent=2)
    f.write("\n")

# Decompress zstd if available.
if dest.endswith(".zst"):
    raw = dest[: -4]
    if not (os.path.isfile(raw) and os.path.getsize(raw) > 0):
        import shutil, subprocess
        if shutil.which("zstd"):
            subprocess.check_call(["zstd", "-d", "-f", dest, "-o", raw])
            print(f"decompressed: {raw}")
        else:
            print("zstd not installed; left compressed wasm in place")

print(f"firefox wasm assets in {out_dir}")
print("Wire via TRANSLATASM_CJK=1 and Bergamot 2.x-compatible worker when integrating.")
PY

echo "firefox wasm fetch done"
