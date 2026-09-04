#!/usr/bin/env bash
# Fetch Bergamot WASM + Marian packs + readable fonts into web/.
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

# all = Bergamot S3 tiny set + curated Firefox extras
PAIRS="${TRANSLATASM_PAIRS:-all}"
EXTRAS="${TRANSLATASM_EXTRAS:-1}"

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

# Display: Latin only. Body: IBM Plex Sans with Cyrillic + Greek coverage.
download "https://cdn.jsdelivr.net/fontsource/fonts/bricolage-grotesque@5.2.8/latin-700-normal.woff2" \
  "$FONT_DIR/bricolage-700.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.2.5/latin-400-normal.woff2" \
  "$FONT_DIR/plex-latin-400.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.2.5/latin-600-normal.woff2" \
  "$FONT_DIR/plex-latin-600.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.2.5/cyrillic-400-normal.woff2" \
  "$FONT_DIR/plex-cyrillic-400.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.2.5/cyrillic-600-normal.woff2" \
  "$FONT_DIR/plex-cyrillic-600.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.2.5/greek-400-normal.woff2" \
  "$FONT_DIR/plex-greek-400.woff2"
download "https://cdn.jsdelivr.net/fontsource/fonts/ibm-plex-sans@5.2.5/greek-600-normal.woff2" \
  "$FONT_DIR/plex-greek-600.woff2"

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
if [[ "$EXTRAS" != "0" ]]; then
  echo "fetching Firefox Translations model index"
  curl -L --fail --retry 5 --retry-delay 2 -o "$FF_JSON" "$FF_RECORDS_URL"
else
  echo '{"data":[]}' >"$FF_JSON"
fi

python3 - "$INDEX_JSON" "$FF_JSON" "$MODEL_DIR" "$PAIRS" "$EXTRAS" "$FF_ATTACH_BASE" <<'PY'
import gzip, http.client, json, os, sys, time, urllib.error, urllib.request

index_path, ff_path, model_dir, pairs_arg, extras_arg, attach_base = sys.argv[1:7]
with open(index_path, encoding="utf-8") as f:
    index = json.load(f)
with open(ff_path, encoding="utf-8") as f:
    ff_records = json.load(f).get("data") or []

if pairs_arg.strip() == "all":
    pairs = sorted(index.keys())
else:
    pairs = pairs_arg.split()

# Curated Firefox extras (v1-friendly). Skips CJK and huge 2.x packs unless TRANSLATASM_CJK=1.
EXTRA_LANGS = {
    "pl", "nl", "sv", "da", "fi", "hu", "ro", "el", "tr",
    "ca", "hr", "sk", "sl", "id", "vi", "nb",
}
CJK_LANGS = {"zh", "ja"}
cjk_arg = os.environ.get("TRANSLATASM_CJK", "0")
if cjk_arg == "1":
    EXTRA_LANGS = set(EXTRA_LANGS) | CJK_LANGS


registry = {}

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

def default_config(model_name: str, remote=None) -> dict:
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
    if isinstance(remote, dict):
        for k, v in remote.items():
            if v is not None:
                cfg[k] = v
    return cfg

def add_pair(pair: str, from_code: str, to_code: str, files_out: dict) -> None:
    files_out["from"] = from_code
    files_out["to"] = to_code
    registry[pair] = files_out

# Bergamot S3 tiny packs
for pair in pairs:
    if pair not in index:
        raise SystemExit(f"pair {pair} not in Bergamot index")
    entry = index[pair]
    from_code, to_code = pair[:2], pair[2:4]
    dest_dir = os.path.join(model_dir, "tiny", pair)
    os.makedirs(dest_dir, exist_ok=True)
    files_out = {}

    model_meta = entry.get("model")
    if not model_meta or not model_meta.get("name"):
        raise SystemExit(f"missing model for {pair}")
    model_local = f"model.{pair}.bin"
    model_dest = os.path.join(dest_dir, model_local)
    fetch(model_meta["name"], model_dest)
    files_out["model"] = {
        "name": f"/models/tiny/{pair}/{model_local}",
        "size": os.path.getsize(model_dest),
        "expectedSha256Hash": "",
    }

    lex_meta = entry.get("lex")
    if not lex_meta or not lex_meta.get("name"):
        raise SystemExit(f"missing lex for {pair}")
    lex_local = f"lex.{pair}.s2t.bin"
    lex_dest = os.path.join(dest_dir, lex_local)
    fetch(lex_meta["name"], lex_dest)
    files_out["lex"] = {
        "name": f"/models/tiny/{pair}/{lex_local}",
        "size": os.path.getsize(lex_dest),
        "expectedSha256Hash": "",
    }

    if entry.get("vocab") and entry["vocab"].get("name"):
        vocab_local = f"vocab.{pair}.spm"
        vocab_dest = os.path.join(dest_dir, vocab_local)
        fetch(entry["vocab"]["name"], vocab_dest)
        files_out["vocab"] = {
            "name": f"/models/tiny/{pair}/{vocab_local}",
            "size": os.path.getsize(vocab_dest),
            "expectedSha256Hash": "",
        }
    else:
        for part, local_name in (
            ("srcvocab", f"srcvocab.{pair}.spm"),
            ("trgvocab", f"trgvocab.{pair}.spm"),
        ):
            meta = entry.get(part)
            if not meta or not meta.get("name"):
                raise SystemExit(f"missing {part} for {pair}")
            dest = os.path.join(dest_dir, local_name)
            fetch(meta["name"], dest)
            files_out[part] = {
                "name": f"/models/tiny/{pair}/{local_name}",
                "size": os.path.getsize(dest),
                "expectedSha256Hash": "",
            }

    model_name = (model_meta.get("name") or "").rsplit("/", 1)[-1]
    files_out["config"] = default_config(model_name, entry.get("config"))
    add_pair(pair, from_code, to_code, files_out)

def pick_firefox_files(records, prefer_cjk=False):
    by_ver = {}
    for r in records:
        by_ver.setdefault(r.get("version") or "", []).append(r)

    def score(v):
        if prefer_cjk:
            if v.startswith("2."):
                return (0, v)
            if v.startswith("1.0"):
                return (2, v)
            if v.startswith("1."):
                return (3, v)
            return (1, v)
        if v.startswith("1.0"):
            return (0, v)
        if v.startswith("1."):
            return (1, v)
        if v.startswith("2.0"):
            return (2, v)
        return (3, v)

    for ver in sorted(by_ver, key=score):
        files = {r["fileType"]: r for r in by_ver[ver] if r.get("fileType")}
        has_vocab = "vocab" in files or ("srcvocab" in files and "trgvocab" in files)
        if "model" in files and "lex" in files and has_vocab:
            return ver, files
    return None, None

if extras_arg != "0":
    grouped = {}
    for r in ff_records:
        fl = r.get("fromLang")
        tl = r.get("toLang")
        if not fl or not tl:
            continue
        if fl != "en" and tl != "en":
            continue
        other = tl if fl == "en" else fl
        if other not in EXTRA_LANGS:
            continue
        # Skip multi-part tags that break 2+2 registry keys.
        if "-" in fl or "-" in tl:
            continue
        grouped.setdefault((fl, tl), []).append(r)

    for (fl, tl), recs in sorted(grouped.items()):
        pair = fl + tl
        if pair in registry:
            continue
        prefer_cjk = (fl in CJK_LANGS) or (tl in CJK_LANGS)
        ver, files = pick_firefox_files(recs, prefer_cjk=prefer_cjk)
        if not files:
            print(f"skip {pair}: incomplete firefox records")
            continue
        if prefer_cjk and not str(ver).startswith("2"):
            print(f"warn {pair}: no 2.x pack found (got v{ver}); needs Bergamot WASM 2.x")
        dest_dir = os.path.join(model_dir, "tiny", pair)
        os.makedirs(dest_dir, exist_ok=True)
        files_out = {}
        model_name = files["model"].get("name") or f"model.{pair}.bin"

        for part, local_name in (
            ("model", f"model.{pair}.bin"),
            ("lex", f"lex.{pair}.s2t.bin"),
        ):
            meta = files[part]
            att = meta.get("attachment") or {}
            loc = att.get("location")
            if not loc:
                raise SystemExit(f"missing attachment for {pair} {part}")
            dest = os.path.join(dest_dir, local_name)
            fetch(attach_base + loc, dest)
            files_out[part] = {
                "name": f"/models/tiny/{pair}/{local_name}",
                "size": os.path.getsize(dest),
                "expectedSha256Hash": "",
            }

        if "vocab" in files:
            meta = files["vocab"]
            att = meta.get("attachment") or {}
            dest = os.path.join(dest_dir, f"vocab.{pair}.spm")
            fetch(attach_base + att["location"], dest)
            files_out["vocab"] = {
                "name": f"/models/tiny/{pair}/vocab.{pair}.spm",
                "size": os.path.getsize(dest),
                "expectedSha256Hash": "",
            }
        else:
            for part, local_name in (
                ("srcvocab", f"srcvocab.{pair}.spm"),
                ("trgvocab", f"trgvocab.{pair}.spm"),
            ):
                meta = files[part]
                att = meta.get("attachment") or {}
                dest = os.path.join(dest_dir, local_name)
                fetch(attach_base + att["location"], dest)
                files_out[part] = {
                    "name": f"/models/tiny/{pair}/{local_name}",
                    "size": os.path.getsize(dest),
                    "expectedSha256Hash": "",
                }

        files_out["config"] = default_config(model_name)
        add_pair(pair, fl, tl, files_out)
        print(f"firefox {pair} v{ver}")

out = os.path.join(model_dir, "registry.json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(registry, f, indent=2)
    f.write("\n")
print(f"wrote {out} ({len(registry)} pairs)")
PY

echo "offline assets ready"
echo "pairs: $PAIRS extras: $EXTRAS"
