#!/usr/bin/env bash
# Fetch Bergamot WASM + Marian packs + readable fonts into web/.
#
# Model sources, best first:
#   1. Mozilla Remote Settings "translations-models" (same packs Firefox
#      Translations ships). Newest complete version wins, so pairs get the
#      current 2.x packs instead of the old S3 "tiny" builds.
#   2. Bergamot S3 tiny packs, kept as a fallback for pairs Remote Settings
#      does not cover.
#
# Env:
#   TRANSLATASM_PAIRS   space-separated pair codes, or "all" (default)
#   TRANSLATASM_CJK=1   also fetch en->zh/ja/ko packs (need Bergamot WASM 2.x;
#                       X->en CJK packs work on the stock 0.4.9 WASM)
#   TRANSLATASM_S3_ONLY=1  skip Remote Settings, S3 tiny packs only
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BERG_DIR="$ROOT/web/vendor/bergamot"
BERG_WORKER="$BERG_DIR/worker"
MODEL_DIR="$ROOT/web/models"
FONT_DIR="$ROOT/web/fonts"
NPM="https://cdn.jsdelivr.net/npm/@browsermt/bergamot-translator@0.4.9"
INDEX_URL="https://bergamot.s3.amazonaws.com/models/index.json"
FF_RECORDS_URL="https://firefox.settings.services.mozilla.com/v1/buckets/main/collections/translations-models/records?_limit=5000"
FF_ATTACH_BASE="https://firefox-settings-attachments.cdn.mozilla.net/"

PAIRS="${TRANSLATASM_PAIRS:-all}"
CJK="${TRANSLATASM_CJK:-0}"
S3_ONLY="${TRANSLATASM_S3_ONLY:-0}"

mkdir -p "$BERG_WORKER" "$MODEL_DIR" "$FONT_DIR" "$MODEL_DIR/tmp"

download() {
  local url="$1"
  local dest="$2"
  if [[ -f "$dest" && -s "$dest" ]]; then
    echo "present: $dest"
    return 0
  fi
  echo "fetching $url"
  curl -L --fail --retry 5 --retry-delay 2 -o "$dest" "$url"
}

download "$NPM/translator.js" "$BERG_DIR/translator.js"
download "$NPM/main.js" "$BERG_DIR/main.js"
download "$NPM/worker/translator-worker.js" "$BERG_WORKER/translator-worker.js"
download "$NPM/worker/bergamot-translator-worker.js" "$BERG_WORKER/bergamot-translator-worker.js"
download "$NPM/worker/bergamot-translator-worker.wasm" "$BERG_WORKER/bergamot-translator-worker.wasm"

# Single family: IBM Plex Sans for display and body, with Cyrillic + Greek coverage.
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.3.0/latin-400-normal.woff2" \
  "$FONT_DIR/plex-latin-400.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.3.0/latin-600-normal.woff2" \
  "$FONT_DIR/plex-latin-600.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.3.0/latin-700-normal.woff2" \
  "$FONT_DIR/plex-latin-700.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.3.0/cyrillic-400-normal.woff2" \
  "$FONT_DIR/plex-cyrillic-400.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.3.0/cyrillic-600-normal.woff2" \
  "$FONT_DIR/plex-cyrillic-600.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.3.0/cyrillic-700-normal.woff2" \
  "$FONT_DIR/plex-cyrillic-700.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.3.0/greek-400-normal.woff2" \
  "$FONT_DIR/plex-greek-400.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.3.0/greek-600-normal.woff2" \
  "$FONT_DIR/plex-greek-600.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.3.0/greek-700-normal.woff2" \
  "$FONT_DIR/plex-greek-700.woff2"

INDEX_GZ="$MODEL_DIR/tmp/index.json.gz"
INDEX_JSON="$MODEL_DIR/tmp/index.json"
echo "fetching $INDEX_URL"
curl -L --fail --retry 5 --retry-delay 2 -o "$INDEX_GZ" "$INDEX_URL"
if gzip -t "$INDEX_GZ" 2>/dev/null; then
  gunzip -c "$INDEX_GZ" >"$INDEX_JSON"
else
  cp "$INDEX_GZ" "$INDEX_JSON"
fi

FF_JSON="$MODEL_DIR/tmp/firefox-records.json"
if [[ "$S3_ONLY" != "1" ]]; then
  echo "fetching Firefox Translations model index"
  curl -L --fail --retry 5 --retry-delay 2 -o "$FF_JSON" "$FF_RECORDS_URL"
else
  echo '{"data":[]}' >"$FF_JSON"
fi

python3 - "$INDEX_JSON" "$FF_JSON" "$MODEL_DIR" "$PAIRS" "$CJK" "$S3_ONLY" "$FF_ATTACH_BASE" <<'PY'
import gzip, http.client, json, os, re, sys, time, urllib.error, urllib.request

index_path, ff_path, model_dir, pairs_arg, cjk_arg, s3_only, attach_base = sys.argv[1:8]
with open(index_path, encoding="utf-8") as f:
    index = json.load(f)
with open(ff_path, encoding="utf-8") as f:
    ff_records = json.load(f).get("data") or []

if pairs_arg.strip() == "all":
    pair_filter = None
else:
    pair_filter = set(pairs_arg.split())

cjk_enabled = cjk_arg == "1"

# Targets that need the Firefox/WASM 2.x runtime (en->CJK produces garbage or
# fails on the stock 0.4.9 build). X->en CJK packs work fine on 0.4.9.
WASM2X_TARGETS = {"zh", "ja", "ko", "zh-hant"}


def norm_code(tag):
    """Remote Settings lang tag -> catalog code."""
    t = (tag or "").strip().lower()
    if t == "zh-hans":
        return "zh"
    if t == "zh-hant":
        return "zh-hant"
    return t


def version_key(v):
    """Sortable key: higher base version wins; stable beats alpha of same base."""
    m = re.match(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?(.*)$", str(v))
    if not m:
        return (0, 0, 0, 0)
    major = int(m.group(1))
    minor = int(m.group(2) or 0)
    patch = int(m.group(3) or 0)
    suffix = m.group(4) or ""
    stable = 0 if re.search(r"[ab]|alpha|beta|rc", suffix, re.I) else 1
    return (major, minor, patch, stable)


def complete_filetypes(fts):
    return (
        "model" in fts
        and "lex" in fts
        and ("vocab" in fts or ("srcvocab" in fts and "trgvocab" in fts))
    )


def gunzip_if_needed(path: str) -> None:
    with open(path, "rb") as f:
        head = f.read(2)
        rest = f.read()
    if head != b"\x1f\x8b":
        return
    data = gzip.decompress(head + rest)
    with open(path, "wb") as f:
        f.write(data)
    print(f"gunzipped: {path}")


def fetch(url: str, dest: str, attempts: int = 5) -> None:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        gunzip_if_needed(dest)
        if os.path.getsize(dest) > 0:
            print(f"present: {dest}")
            return
    print(f"fetching {url}")
    last_err = None
    for i in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"Accept-Encoding": "identity"})
            with urllib.request.urlopen(req, timeout=120) as resp:
                data = resp.read()
            with open(dest, "wb") as f:
                f.write(data)
            gunzip_if_needed(dest)
            return
        except (urllib.error.URLError, TimeoutError, http.client.IncompleteRead, OSError) as err:
            last_err = err
            if os.path.isfile(dest):
                os.remove(dest)
            wait = min(2 ** i, 30)
            print(f"retry {i}/{attempts} after {err!r} (sleep {wait}s)")
            time.sleep(wait)
    raise RuntimeError(f"failed to fetch {url}: {last_err!r}")


def default_config(model_name: str) -> dict:
    cfg = {
        "beam-size": "1",
        "normalize": "1.0",
        "word-penalty": "0",
        "max-length-break": "128",
        "mini-batch-words": "1024",
        "workspace": "128",
        "max-length-factor": "2.0",
        "skip-cost": True,
        "cpu-threads": "0",
        "quiet": True,
        "quiet-translation": True,
        "alignment": "soft",
        "gemm-precision": "int8shiftAlphaAll",
    }
    if model_name.endswith("intgemm8.bin"):
        cfg["gemm-precision"] = "int8shiftAll"
    return cfg


registry = {}

PART_FILETYPES = {
    "model": "model",
    "lex": "lex",
    "vocab": "vocab",
    "srcvocab": "srcvocab",
    "trgvocab": "trgvocab",
}


def wanted(fl: str, tl: str) -> bool:
    """Whether a pair should be fetched under current env flags."""
    if pair_filter is not None and fl + tl not in pair_filter:
        return False
    if tl in WASM2X_TARGETS and not cjk_enabled:
        return False
    return True


# --- Firefox Remote Settings packs (preferred) ---
if s3_only != "1":
    grouped = {}
    for r in ff_records:
        fl = norm_code(r.get("fromLang"))
        tl = norm_code(r.get("toLang"))
        if not fl or not tl or fl == "en" and tl == "en":
            continue
        # All Remote Settings packs pivot through English.
        if fl != "en" and tl != "en":
            continue
        grouped.setdefault((fl, tl), {}).setdefault(str(r.get("version") or ""), []).append(r)

    for (fl, tl), versions in sorted(grouped.items()):
        pair = fl + tl
        if pair in registry:
            continue
        if not wanted(fl, tl):
            continue
        # Pick the newest version with a complete file set.
        best_ver, best_files = None, None
        for ver in sorted(versions, key=version_key, reverse=True):
            by_type = {}
            for r in versions[ver]:
                ft = r.get("fileType")
                if ft not in PART_FILETYPES:
                    continue
                # Keep the most recently modified record per file type.
                prev = by_type.get(ft)
                if prev is None or (r.get("last_modified") or 0) >= (prev.get("last_modified") or 0):
                    by_type[ft] = r
            if complete_filetypes(by_type):
                best_ver, best_files = ver, by_type
                break
        if not best_files:
            print(f"skip {pair}: no complete firefox pack")
            continue

        dest_dir = os.path.join(model_dir, "hq", pair)
        os.makedirs(dest_dir, exist_ok=True)
        files_out = {"from": fl, "to": tl}
        model_remote_name = ""
        for ft, part in PART_FILETYPES.items():
            if ft not in best_files:
                continue
            meta = best_files[ft]
            att = meta.get("attachment") or {}
            loc = att.get("location")
            if not loc:
                raise SystemExit(f"missing attachment for {pair} {ft}")
            remote_name = att.get("filename") or meta.get("name") or f"{part}.{pair}.bin"
            if ft == "model":
                model_remote_name = remote_name
            dest = os.path.join(dest_dir, remote_name)
            fetch(attach_base + loc, dest)
            files_out[part] = {
                "name": f"/models/hq/{pair}/{remote_name}",
                "size": os.path.getsize(dest),
                "expectedSha256Hash": "",
            }
        files_out["config"] = default_config(model_remote_name)
        registry[pair] = files_out
        print(f"firefox {pair} v{best_ver} ({fl}->{tl})")

# --- Bergamot S3 tiny packs (fallback / S3-only mode) ---
s3_pairs = sorted(index.keys()) if pairs_arg.strip() == "all" else pairs_arg.split()
for pair in s3_pairs:
    fl, tl = norm_code(pair[:2]), norm_code(pair[2:4])
    if tl in WASM2X_TARGETS and not cjk_enabled:
        continue
    key = fl + tl
    if key in registry:
        continue
    if pair_filter is not None and key not in pair_filter:
        continue
    if pair not in index:
        if s3_only == "1":
            raise SystemExit(f"pair {pair} not in Bergamot index")
        continue
    entry = index[pair]
    dest_dir = os.path.join(model_dir, "tiny", pair)
    os.makedirs(dest_dir, exist_ok=True)
    files_out = {"from": fl, "to": tl}

    model_meta = entry.get("model")
    if not model_meta or not model_meta.get("name"):
        if s3_only == "1":
            raise SystemExit(f"missing model for {pair}")
        continue
    model_local = model_meta["name"].rsplit("/", 1)[-1]
    model_dest = os.path.join(dest_dir, model_local)
    fetch(model_meta["name"], model_dest)
    files_out["model"] = {
        "name": f"/models/tiny/{pair}/{model_local}",
        "size": os.path.getsize(model_dest),
        "expectedSha256Hash": "",
    }

    lex_meta = entry.get("lex")
    if not lex_meta or not lex_meta.get("name"):
        if s3_only == "1":
            raise SystemExit(f"missing lex for {pair}")
        continue
    lex_local = lex_meta["name"].rsplit("/", 1)[-1]
    lex_dest = os.path.join(dest_dir, lex_local)
    fetch(lex_meta["name"], lex_dest)
    files_out["lex"] = {
        "name": f"/models/tiny/{pair}/{lex_local}",
        "size": os.path.getsize(lex_dest),
        "expectedSha256Hash": "",
    }

    if entry.get("vocab") and entry["vocab"].get("name"):
        vocab_local = entry["vocab"]["name"].rsplit("/", 1)[-1]
        vocab_dest = os.path.join(dest_dir, vocab_local)
        fetch(entry["vocab"]["name"], vocab_dest)
        files_out["vocab"] = {
            "name": f"/models/tiny/{pair}/{vocab_local}",
            "size": os.path.getsize(vocab_dest),
            "expectedSha256Hash": "",
        }
    else:
        ok = True
        for part, meta_key in (("srcvocab", "srcvocab"), ("trgvocab", "trgvocab")):
            meta = entry.get(meta_key)
            if not meta or not meta.get("name"):
                ok = False
                break
            local_name = meta["name"].rsplit("/", 1)[-1]
            dest = os.path.join(dest_dir, local_name)
            fetch(meta["name"], dest)
            files_out[part] = {
                "name": f"/models/tiny/{pair}/{local_name}",
                "size": os.path.getsize(dest),
                "expectedSha256Hash": "",
            }
        if not ok:
            if s3_only == "1":
                raise SystemExit(f"missing vocab for {pair}")
            continue

    model_name = model_meta["name"].rsplit("/", 1)[-1]
    files_out["config"] = default_config(model_name)
    registry[key] = files_out
    print(f"s3 {pair} ({fl}->{tl})")

out = os.path.join(model_dir, "registry.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(registry, f, indent=2)
    f.write("\n")
print(f"wrote {out} ({len(registry)} pairs)")
PY

echo "offline assets ready"
echo "pairs: $PAIRS cjk: $CJK s3_only: $S3_ONLY"
