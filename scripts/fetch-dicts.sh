#!/usr/bin/env bash
# Build offline dictionary packs under web/dicts/ from Kaikki + FreeDict.
# Set TRANSLATASM_DICT_LANGS to a space-separated subset (default: all).
# Set TRANSLATASM_DICT_MAX=N to cap Kaikki entries per language (0 = no cap).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DICT_DIR="$ROOT/web/dicts"
TMP="$DICT_DIR/tmp"
SCRIPT_DIR="$ROOT/scripts/dicts"
LANGS_ARG="${TRANSLATASM_DICT_LANGS:-all}"
MAX_ENTRIES="${TRANSLATASM_DICT_MAX:-0}"

mkdir -p "$DICT_DIR/mono" "$DICT_DIR/bi" "$TMP"

python3 - "$ROOT" "$DICT_DIR" "$TMP" "$SCRIPT_DIR" "$LANGS_ARG" "$MAX_ENTRIES" <<'PY'
import gzip
import json
import os
import shutil
import sys
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET

root, dict_dir, tmp, script_dir, langs_arg, max_entries_s = sys.argv[1:7]
sys.path.insert(0, script_dir)
from languages import ALL_LANGS, FREEDICT_CODES, KAIKKI_NAMES  # noqa: E402
from trim_kaikki import process_file  # noqa: E402
from convert_freedict import parse_tei, write_pack  # noqa: E402

max_entries = int(max_entries_s)
if langs_arg.strip() == "all":
    langs = list(ALL_LANGS)
else:
    langs = langs_arg.split()

def fetch(url: str, dest: str) -> bool:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    if os.path.isfile(dest) and os.path.getsize(dest) > 0:
        print(f"present: {dest}")
        return True
    print(f"fetching {url}")
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "translatasm-dicts/0.1"})
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = resp.read()
    except Exception as exc:  # noqa: BLE001
        print(f"skip: {url} ({exc})")
        return False
    with open(dest, "wb") as f:
        f.write(data)
    return True


def gunzip_to(src: str, dest: str) -> None:
    with gzip.open(src, "rb") as gz, open(dest, "wb") as out:
        shutil.copyfileobj(gz, out)


mono_meta = {}
bi_meta = {}

for lang in langs:
    name = KAIKKI_NAMES.get(lang)
    if not name:
        print(f"unknown lang {lang}")
        continue
    out_dir = os.path.join(dict_dir, "mono", lang)
    if os.path.isfile(os.path.join(out_dir, "meta.json")):
        with open(os.path.join(out_dir, "meta.json"), encoding="utf-8") as f:
            mono_meta[lang] = json.load(f)
        print(f"present mono: {lang}")
        continue

    # Prefer language-specific Kaikki dumps (English glosses from enwiktionary).
    candidates = [
        f"https://kaikki.org/dictionary/{name}/kaikki.org-dictionary-{name}.jsonl.gz",
        f"https://kaikki.org/dictionary/{name}/kaikki.org-dictionary-{name}.json",
    ]
    src = None
    for url in candidates:
        dest = os.path.join(tmp, f"{lang}-kaikki" + (".jsonl.gz" if url.endswith(".gz") else ".jsonl"))
        if fetch(url, dest):
            if dest.endswith(".gz"):
                plain = dest[: -3]
                if not os.path.isfile(plain):
                    gunzip_to(dest, plain)
                src = plain
            else:
                src = dest
            break
    if not src:
        print(f"no Kaikki source for {lang}")
        continue
    meta = process_file(src, out_dir, lang, max_entries)
    mono_meta[lang] = meta
    print(f"built mono {lang}: {meta['entries']} entries")

# FreeDict bilingual packs: eng <-> each non-English language when available.
for lang in langs:
    if lang == "en":
        continue
    fd = FREEDICT_CODES.get(lang)
    eng = FREEDICT_CODES["en"]
    if not fd:
        continue
    for src_code, dst_code, from_l, to_l in (
        (eng, fd, "en", lang),
        (fd, eng, lang, "en"),
    ):
        pair = f"{from_l}{to_l}"
        out_path = os.path.join(dict_dir, "bi", f"{pair}.json")
        if os.path.isfile(out_path) and os.path.getsize(out_path) > 0:
            with open(out_path, "rb") as f:
                raw = f.read()
            bi_meta[pair] = {
                "from": from_l,
                "to": to_l,
                "path": f"bi/{pair}.json",
                "entries": len(json.loads(raw).get("entries") or {}),
                "bytes": len(raw),
                "size_hint_mb": round(len(raw) / (1024 * 1024), 2),
            }
            print(f"present bi: {pair}")
            continue
        tei_name = f"{src_code}-{dst_code}"
        urls = [
            f"https://download.freedict.org/dictionaries/{tei_name}/{tei_name}.tei.xz",
            f"https://download.freedict.org/dictionaries/{tei_name}/{tei_name}.tei",
        ]
        tei_path = None
        for url in urls:
            dest = os.path.join(tmp, os.path.basename(url))
            if not fetch(url, dest):
                continue
            if dest.endswith(".xz"):
                import lzma

                plain = dest[: -3]
                if not os.path.isfile(plain):
                    with lzma.open(dest, "rb") as xz, open(plain, "wb") as out:
                        shutil.copyfileobj(xz, out)
                tei_path = plain
            else:
                tei_path = dest
            break
        if not tei_path:
            print(f"no FreeDict TEI for {pair}")
            continue
        try:
            entries = parse_tei(tei_path)
        except ET.ParseError as exc:
            print(f"bad TEI {pair}: {exc}")
            continue
        meta = write_pack(entries, out_path, from_l, to_l)
        meta["path"] = f"bi/{pair}.json"
        bi_meta[pair] = meta
        print(f"built bi {pair}: {meta['entries']} entries")

registry = {
    "version": 1,
    "pivot": "en",
    "attribution": [
        "Monolingual definitions: Wiktionary via Kaikki.org / Wiktextract (CC BY-SA)",
        "Bilingual glosses: FreeDict",
    ],
    "mono": {},
    "bi": {},
}

for lang, meta in mono_meta.items():
    registry["mono"][lang] = {
        "lang": lang,
        "path": f"mono/{lang}/meta.json",
        "entries": meta.get("entries", 0),
        "size_hint_mb": meta.get("size_hint_mb", 0),
        "shards": meta.get("shards", []),
        "attribution": meta.get("attribution", ""),
    }

for pair, meta in bi_meta.items():
    registry["bi"][pair] = {
        "id": pair,
        "from": meta["from"],
        "to": meta["to"],
        "path": meta["path"],
        "entries": meta.get("entries", 0),
        "size_hint_mb": meta.get("size_hint_mb", 0),
        "attribution": "FreeDict",
    }

# Keep fixture packs discoverable even when fetch skipped a language.
for lang in langs:
    meta_path = os.path.join(dict_dir, "mono", lang, "meta.json")
    if lang not in registry["mono"] and os.path.isfile(meta_path):
        with open(meta_path, encoding="utf-8") as f:
            meta = json.load(f)
        registry["mono"][lang] = {
            "lang": lang,
            "path": f"mono/{lang}/meta.json",
            "entries": meta.get("entries", 0),
            "size_hint_mb": meta.get("size_hint_mb", 0),
            "shards": meta.get("shards", []),
            "attribution": meta.get("attribution", ""),
        }

for name in os.listdir(os.path.join(dict_dir, "bi")):
    if not name.endswith(".json"):
        continue
    pair = name[: -5]
    if pair in registry["bi"]:
        continue
    path = os.path.join(dict_dir, "bi", name)
    with open(path, "rb") as f:
        raw = f.read()
    data = json.loads(raw)
    registry["bi"][pair] = {
        "id": pair,
        "from": data.get("from", pair[:2]),
        "to": data.get("to", pair[2:]),
        "path": f"bi/{name}",
        "entries": len(data.get("entries") or {}),
        "size_hint_mb": round(len(raw) / (1024 * 1024), 2),
        "attribution": data.get("attribution", "FreeDict"),
    }

reg_path = os.path.join(dict_dir, "registry.json")
with open(reg_path, "w", encoding="utf-8") as f:
    json.dump(registry, f, ensure_ascii=False, indent=2)
    f.write("\n")
print(f"wrote {reg_path}")
PY

echo "dicts ready under $DICT_DIR"
