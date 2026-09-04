#!/usr/bin/env python3
"""Convert FreeDict TEI XML into a compact bilingual JSON gloss map."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import xml.etree.ElementTree as ET
from collections import defaultdict

TEI_NS = {"tei": "http://www.tei-c.org/ns/1.0"}


def local(tag: str) -> str:
    if "}" in tag:
        return tag.rsplit("}", 1)[-1]
    return tag


def text_of(el: ET.Element | None) -> str:
    if el is None:
        return ""
    return re.sub(r"\s+", " ", "".join(el.itertext()).strip())


def parse_tei(path: str) -> dict[str, list[str]]:
    tree = ET.parse(path)
    root = tree.getroot()
    out: dict[str, list[str]] = defaultdict(list)

    for entry in root.iter():
        if local(entry.tag) != "entry":
            continue
        orths: list[str] = []
        glosses: list[str] = []
        for child in entry.iter():
            name = local(child.tag)
            if name == "orth":
                t = text_of(child)
                if t:
                    orths.append(t)
            elif name in ("quote", "def"):
                t = text_of(child)
                if t:
                    glosses.append(t)
        for orth in orths:
            key = orth.lower().strip()
            if not key or " " in key:
                continue
            seen = set(out[key])
            for g in glosses:
                g = g.strip()
                if not g or g in seen:
                    continue
                out[key].append(g)
                seen.add(g)
                if len(out[key]) >= 6:
                    break
    return {k: v for k, v in out.items() if v}


def write_pack(entries: dict[str, list[str]], dest: str, from_lang: str, to_lang: str) -> dict:
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    payload = {
        "from": from_lang,
        "to": to_lang,
        "entries": entries,
        "attribution": "FreeDict (free bilingual dictionaries)",
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    with open(dest, "wb") as f:
        f.write(raw)
    return {
        "from": from_lang,
        "to": to_lang,
        "path": dest,
        "entries": len(entries),
        "bytes": len(raw),
        "size_hint_mb": round(len(raw) / (1024 * 1024), 2),
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("tei", help="FreeDict TEI XML path")
    ap.add_argument("out", help="Output JSON path")
    ap.add_argument("--from", dest="from_lang", required=True)
    ap.add_argument("--to", dest="to_lang", required=True)
    args = ap.parse_args()
    entries = parse_tei(args.tei)
    meta = write_pack(entries, args.out, args.from_lang, args.to_lang)
    print(json.dumps({"ok": True, "meta": meta}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
