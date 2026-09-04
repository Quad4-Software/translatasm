# translatasm

Offline neural machine translation in the browser via Bergamot (Marian NMT) WASM.

**29 languages** (includes Chinese and Japanese when CJK packs are fetched), 56 direct packs with English pivot for cross pairs. Text stays on device after models load.

**Live:** [https://translatasm.quad4.io](https://translatasm.quad4.io)

## Languages

English, Bulgarian, Catalan, Chinese, Croatian, Czech, Danish, Dutch, Estonian, Finnish, French, German, Greek, Hungarian, Indonesian, Italian, Japanese, Norwegian, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Turkish, Ukrainian, Vietnamese.

Chinese and Japanese packs need Firefox Translations WASM 2.x with CJK segmentation. Default build ships Bergamot 0.4.9. Enable with:

```bash
TRANSLATASM_CJK=1 make assets
```

That fetches 2.x language packs and Firefox Remote Settings WASM into `web/vendor/bergamot-firefox/`. The UI pre-segments CJK via `Intl.Segmenter`. Full drop-in of Firefox WASM 2.x as the sole engine still requires a worker bridge beyond npm 0.4.9.

## Install (Docker)

```bash
git clone git@github.com:Quad4-Software/translatasm.git
cd translatasm
make assets
docker compose up --build
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080).

Build with full dictionary packs baked in:

```bash
TRANSLATASM_DICTS=1 make assets
docker compose up --build
```

## Build from source

Needs Go 1.26+, `curl`, `gunzip`, and Python 3.

```bash
cd translatasm
make assets   # WASM + Bergamot tiny packs + Firefox extras (~1.1 GB)
make run
```

Bergamot S3 only (no Firefox extras):

```bash
TRANSLATASM_EXTRAS=0 make assets
```

Subset of packs:

```bash
TRANSLATASM_PAIRS="enes esen enfr fren" TRANSLATASM_EXTRAS=0 make assets
```

```bash
make test
make bench
```

## Features

- Live typing translate with adaptive debounce and request supersede
- Auto language detect (native LanguageDetector, optional cld3, heuristic fallback)
- Shareable URL (`?from=&to=&q=&html=1&auto=1&align=1`)
- HTML markup-aware translate toggle
- File drop for `.txt` / `.md` / `.srt` with download
- Term glossary (do-not-translate) and vocab notebook with spaced review
- Sentence align mode (click to highlight peer sentence)
- Offline dictionary drawer (Kaikki + FreeDict)

## Speed notes

- One Bergamot worker stays warm (no reload on language change)
- Translation cache (~128k entries) and Firefox native IntGEMM when available
- Unused language packs are freed from the WASM heap when the pair changes
- Paragraph chunking for long text (HTML-safe splits when HTML mode is on)
- Direct packs when available, otherwise pivot through English

## Offline dictionary

Right-side drawer with bilingual glosses, trimmed monolingual defs, glossary, and a personal vocab notebook. Packs lazy-load on first lookup and cache via the service worker.

Fixture packs for English and Spanish ship in `web/dicts/`. Build more languages:

```bash
make dicts
# or a subset:
TRANSLATASM_DICT_LANGS="en es fr de" make dicts
```

Full Kaikki dumps are large. `TRANSLATASM_DICTS=1 make assets` also builds dicts. Cross-pair glosses fall back through English when a direct FreeDict pack is missing.

## License

0BSD
