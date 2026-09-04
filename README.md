# translatasm

Offline neural machine translation in the browser via Bergamot (Marian NMT) WASM.

**27 languages**, 52 direct packs, English pivot for cross pairs (for example Spanish -> French). Text stays on device after models load.

**Live:** [https://translatasm.quad4.io](https://translatasm.quad4.io)

## Languages

English, Bulgarian, Catalan, Croatian, Czech, Danish, Dutch, Estonian, Finnish, French, German, Greek, Hungarian, Indonesian, Italian, Norwegian, Polish, Portuguese, Romanian, Russian, Slovak, Slovenian, Spanish, Swedish, Turkish, Ukrainian, Vietnamese.

Chinese and Japanese are not supported yet. Those packs need Firefox Translations WASM 2.x with CJK segmentation. This build ships Bergamot 0.4.9.

## Install (Docker)

```bash
git clone git@github.com:Quad4-Software/translatasm.git
cd translatasm
make assets
docker compose up --build
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080).

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

## Speed notes

- One Bergamot worker stays warm (no reload on language change)
- Translation cache (~128k entries) and Firefox native IntGEMM when available
- Adaptive typing debounce + request supersede
- Unused language packs are freed from the WASM heap when the pair changes
- Paragraph chunking for long text
- Direct packs when available, otherwise pivot through English
- Bergamot has no WebGPU/WebGL path today. Speed comes from WASM SIMD and optional Firefox `mozIntGemm`

## License

0BSD
