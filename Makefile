# translatasm offline browser Bergamot / Marian translation
#
# Targets:
#   make assets      download WASM + tiny language packs + fonts
#   make dicts       build offline dictionary packs (Kaikki + FreeDict)
#   make catalog     write web/catalog.json for static hosting
#   make build       compile server
#   make run         run on :8080
#   make test        go tests
#   make lint        golangci-lint
#   make sec         gosec + govulncheck
#   make check       test + lint + sec

APP        := translatasm
MODULE     := github.com/Quad4-Software/translatasm
CMD        := ./cmd/translatasm
BIN_DIR    := bin
BIN        := $(BIN_DIR)/$(APP)
GO         ?= go
GOFLAGS    ?=
LDFLAGS    ?= -s -w -X $(MODULE)/internal/version.Version=$(VERSION)
VERSION    ?= 0.1.0

GOLANGCI_LINT ?= golangci-lint
GOSEC         ?= gosec
GOVULNCHECK   ?= govulncheck
STATICCHECK   ?= staticcheck
GOIMPORTS     ?= goimports
NODE          ?= node

.PHONY: all assets dicts catalog build run test test-go test-js lint sec check fmt vet staticcheck clean help bench

all: assets build

help:
	@printf '%s\n' \
		'assets        fetch Bergamot WASM + all language packs + fonts' \
		'dicts         build offline dictionary packs (Kaikki + FreeDict)' \
		'catalog       write web/catalog.json for static hosting' \
		'build         compile $(BIN)' \
		'run           ensure assets then serve :8080' \
		'test          go + js tests' \
		'bench         bergamot latency + soft accuracy' \
		'lint          golangci-lint run' \
		'sec           gosec + govulncheck' \
		'check         test + lint + sec' \
		'clean         remove bin/'

assets:
	@bash scripts/fetch-assets.sh
	@if [ "$${TRANSLATASM_CJK:-0}" = "1" ]; then bash scripts/fetch-firefox-wasm.sh; fi
	@$(MAKE) catalog
	@if [ "$${TRANSLATASM_DICTS:-0}" = "1" ]; then $(MAKE) dicts; fi

dicts:
	@bash scripts/fetch-dicts.sh

catalog:
	@$(GO) run ./cmd/gencatalog -o web/catalog.json

bench:
	@$(NODE) scripts/bench-bergamot.mjs

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

build: $(BIN_DIR)
	$(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN) $(CMD)

run: assets build
	$(BIN) -web web -addr :8080

test-go:
	$(GO) test $(GOFLAGS) ./...

test-js:
	$(NODE) --test \
		web/js/engine/pairs.test.mjs \
		web/js/engine/align.test.mjs \
		web/js/dict/lookup.test.mjs \
		web/js/dict/glossary.test.mjs \
		web/js/dict/vocab.test.mjs \
		web/js/ui/urlstate.test.mjs \
		web/js/ui/files.test.mjs \
		web/js/detect/langdetect.test.mjs

test: test-go test-js

vet:
	$(GO) vet ./...

fmt:
	$(GO) fmt ./...
	@if command -v $(GOIMPORTS) >/dev/null 2>&1; then \
		$(GOIMPORTS) -w $$(find . -name '*.go' -not -path './vendor/*'); \
	fi

lint:
	$(GOLANGCI_LINT) run ./...

staticcheck:
	$(STATICCHECK) ./...

sec:
	$(GOSEC) -quiet ./...
	$(GOVULNCHECK) ./...

check: test vet lint sec

clean:
	rm -rf $(BIN_DIR)
