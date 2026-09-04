#!/usr/bin/env python3
"""Trim Kaikki.org JSONL into letter-sharded monolingual dictionary packs."""

from __future__ import annotations

import argparse
import gzip
import json
import os
import re
import sys
from collections import defaultdict
from typing import Any

RARE_TAGS = frozenset(
    {
        "archaic",
        "obsolete",
        "rare",
        "dated",
        "historical",
        "vulgar",
        "slur",
        "offensive",
    }
)
POS_KEEP = frozenset(
    {
        "noun",
        "verb",
        "adj",
        "adv",
        "pron",
        "prep",
        "conj",
        "interj",
        "det",
        "num",
        "particle",
        "phrase",
    }
)
MAX_SENSES = 4
MAX_GLOSS_LEN = 220
MAX_EXAMPLE_LEN = 160


def open_maybe_gzip(path: str):
    if path.endswith(".gz"):
        return gzip.open(path, "rt", encoding="utf-8")
    return open(path, "rt", encoding="utf-8")


def shard_key(word: str) -> str:
    if not word:
        return "_"
    ch = word[0].lower()
    if "a" <= ch <= "z":
        return ch
    if "\u0400" <= ch <= "\u04ff":
        return "cyr"
    if "\u0370" <= ch <= "\u03ff":
        return "el"
    return "_"


def clean_gloss(text: str) -> str:
    text = re.sub(r"\s+", " ", (text or "").strip())
    if len(text) > MAX_GLOSS_LEN:
        text = text[: MAX_GLOSS_LEN - 1].rstrip() + "…"
    return text


def sense_ok(sense: dict[str, Any]) -> bool:
    tags = set(sense.get("tags") or [])
    if tags & RARE_TAGS:
        return False
    glosses = sense.get("glosses") or []
    if not glosses:
        return False
    gloss = clean_gloss(str(glosses[0]))
    if not gloss:
        return False
    if " " not in gloss and len(gloss) < 4:
        return False
    return True


def pick_ipa(entry: dict[str, Any]) -> str:
    for sound in entry.get("sounds") or []:
        if not isinstance(sound, dict):
            continue
        ipa = sound.get("ipa")
        if ipa:
            return str(ipa)
    return ""


def pick_example(sense: dict[str, Any]) -> str:
    for ex in sense.get("examples") or []:
        if isinstance(ex, dict):
            text = ex.get("text") or ""
        else:
            text = str(ex)
        text = re.sub(r"\s+", " ", text.strip())
        if 8 <= len(text) <= MAX_EXAMPLE_LEN:
            return text
    return ""


def trim_entry(obj: dict[str, Any]) -> dict[str, Any] | None:
    word = (obj.get("word") or "").strip()
    if not word or " " in word.strip():
        return None
    pos = (obj.get("pos") or "").strip().lower()
    if pos and pos not in POS_KEEP:
        if pos == "name" or pos == "proper noun":
            return None
    senses_out: list[dict[str, Any]] = []
    for sense in obj.get("senses") or []:
        if not isinstance(sense, dict) or not sense_ok(sense):
            continue
        gloss = clean_gloss(str((sense.get("glosses") or [""])[0]))
        item: dict[str, Any] = {"g": gloss}
        ex = pick_example(sense)
        if ex:
            item["e"] = ex
        syns = []
        for syn in sense.get("synonyms") or []:
            if isinstance(syn, dict):
                w = syn.get("word")
            else:
                w = syn
            if w and isinstance(w, str) and " " not in w:
                syns.append(w)
            if len(syns) >= 3:
                break
        if syns:
            item["s"] = syns
        senses_out.append(item)
        if len(senses_out) >= MAX_SENSES:
            break
    if not senses_out:
        return None
    out: dict[str, Any] = {"w": word, "senses": senses_out}
    if pos:
        out["pos"] = pos
    ipa = pick_ipa(obj)
    if ipa:
        out["ipa"] = ipa
    forms = []
    for form in obj.get("forms") or []:
        if isinstance(form, dict):
            f = form.get("form")
            if f and isinstance(f, str) and f.lower() != word.lower() and " " not in f:
                forms.append(f.lower())
        if len(forms) >= 8:
            break
    if forms:
        out["forms"] = sorted(set(forms))
    return out


def write_shards(out_dir: str, by_shard: dict[str, dict[str, Any]], lang: str) -> dict[str, Any]:
    os.makedirs(out_dir, exist_ok=True)
    shards_meta = []
    total = 0
    bytes_total = 0
    for key in sorted(by_shard.keys()):
        entries = by_shard[key]
        path = os.path.join(out_dir, f"{key}.json")
        payload = {"lang": lang, "shard": key, "entries": entries}
        raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        with open(path, "wb") as f:
            f.write(raw)
        n = len(entries)
        total += n
        bytes_total += len(raw)
        shards_meta.append(
            {
                "id": key,
                "path": f"mono/{lang}/{key}.json",
                "entries": n,
                "bytes": len(raw),
            }
        )
    meta = {
        "lang": lang,
        "entries": total,
        "bytes": bytes_total,
        "size_hint_mb": round(bytes_total / (1024 * 1024), 2),
        "shards": shards_meta,
        "attribution": "Wiktionary via Kaikki.org / Wiktextract (CC BY-SA)",
    }
    with open(os.path.join(out_dir, "meta.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
        f.write("\n")
    return meta


def process_file(src: str, out_dir: str, lang: str, max_entries: int = 0) -> dict[str, Any]:
    by_shard: dict[str, dict[str, Any]] = defaultdict(dict)
    form_index: dict[str, str] = {}
    count = 0
    with open_maybe_gzip(src) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue
            trimmed = trim_entry(obj)
            if not trimmed:
                continue
            word = trimmed["w"]
            key = word.lower()
            shard = shard_key(key)
            bucket = by_shard[shard]
            if key in bucket:
                existing = bucket[key]
                if len(existing.get("senses") or []) < len(trimmed["senses"]):
                    bucket[key] = trimmed
            else:
                bucket[key] = trimmed
            for form in trimmed.get("forms") or []:
                form_index[form] = key
            count += 1
            if max_entries and count >= max_entries:
                break
    for form, lemma in form_index.items():
        shard = shard_key(form)
        bucket = by_shard[shard]
        if form not in bucket:
            bucket[form] = {"w": form, "points_to": lemma}
    return write_shards(out_dir, by_shard, lang)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("src", help="Kaikki JSONL or .jsonl.gz")
    ap.add_argument("out_dir", help="Output directory for shards")
    ap.add_argument("--lang", required=True, help="Language code")
    ap.add_argument("--max-entries", type=int, default=0)
    args = ap.parse_args()
    meta = process_file(args.src, args.out_dir, args.lang, args.max_entries)
    print(json.dumps({"ok": True, "meta": meta}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
