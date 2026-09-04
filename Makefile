# translatasm offline browser Bergamot / Marian translation
#
# Targets:
#   make assets      download WASM + tiny language packs + fonts
#   make dicts       build offline dictionary packs (Kaikki + FreeDict)
#   make catalog     write web/catalog.json for static hosting
#   make build       compile server
#   make run         run on :8080
#   make docker      build local container image (full offline assets)
#   make docker-push buildx push to GHCR (linux/amd64,linux/arm64)
#   make badges      regenerate themed shields.io endpoint JSON
#   make test        go tests
#   make lint        golangci-lint
#   make sec         gosec + govulncheck
#   make check       test + lint + sec
#   make screenshots capture docs/screenshots PNGs

APP        := translatasm
MODULE     := github.com/Quad4-Software/translatasm
CMD        := ./cmd/translatasm
BIN_DIR    := bin
BIN        := $(BIN_DIR)/$(APP)
GO         ?= go
GOFLAGS    ?=
LDFLAGS    ?= -s -w -X $(MODULE)/internal/version.Version=$(VERSION)
VERSION    ?= 0.2.0
IMAGE      ?= ghcr.io/quad4-software/$(APP):$(VERSION)
PLATFORMS  ?= linux/amd64,linux/arm64

GOLANGCI_LINT ?= golangci-lint
GOSEC         ?= gosec
GOVULNCHECK   ?= govulncheck
STATICCHECK   ?= staticcheck
GOIMPORTS     ?= goimports
NODE          ?= node
PLAYWRIGHT_PKG ?= playwright@1.62.1
PLAYWRIGHT_INSTALL_ARGS ?=
TOOLS_DIR     := .tools

.PHONY: all assets dicts catalog stamp-sw build run docker docker-push badges test test-go test-js lint sec check fmt vet staticcheck clean help bench screenshots extensions

all: assets build

help:
	@printf '%s\n' \
		'assets        fetch Bergamot WASM + all language packs + fonts' \
		'dicts         build offline dictionary packs (Kaikki + FreeDict)' \
		'catalog       write web/catalog.json for static hosting' \
		'stamp-sw      set SHELL_VERSION in web/sw.js (SHELL_VERSION=... or git sha)' \
		'extensions    build Chrome CRX/ZIP + Firefox XPI into web/build' \
		'build         compile $(BIN)' \
		'run           ensure assets then serve :8080' \
		'docker        build $(IMAGE) with full offline assets' \
		'docker-push   buildx push $(IMAGE) for $(PLATFORMS)' \
		'badges        regenerate themed shields endpoint JSON' \
		'test          go + js tests' \
		'bench         bergamot latency + soft accuracy' \
		'screenshots   capture docs/screenshots via Playwright' \
		'lint          golangci-lint run' \
		'sec           gosec + govulncheck' \
		'check         test + lint + sec' \
		'clean         remove bin/'

stamp-sw:
	@SHELL_VERSION="$${SHELL_VERSION:-$(VERSION)}"; \
	if [ -z "$$SHELL_VERSION" ] || [ "$$SHELL_VERSION" = "0.2.0" ]; then \
	  SHELL_VERSION=$$(git rev-parse --short=12 HEAD 2>/dev/null || echo dev); \
	fi; \
	sed -i "s/const SHELL_VERSION = '[^']*'/const SHELL_VERSION = '$$SHELL_VERSION'/" web/sw.js; \
	printf 'stamped SHELL_VERSION=%s\n' "$$SHELL_VERSION"

extensions:
	bash scripts/build-extensions.sh


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

# Capture desktop/mobile/dict PNGs into docs/screenshots.
# Default URL is the live site. Override with SCREENSHOT_URL=... or SCREENSHOT_LOCAL=1.
screenshots: $(TOOLS_DIR)/node_modules/playwright
	@mkdir -p docs/screenshots
	@if ! command -v chromium >/dev/null 2>&1 \
		&& ! command -v chromium-browser >/dev/null 2>&1 \
		&& ! command -v google-chrome >/dev/null 2>&1 \
		&& [ -z "$${CHROME_PATH:-}" ]; then \
		$(TOOLS_DIR)/node_modules/.bin/playwright install $(PLAYWRIGHT_INSTALL_ARGS) chromium; \
	fi
	@NODE_PATH=$(TOOLS_DIR)/node_modules $(NODE) scripts/screenshot.mjs

$(TOOLS_DIR)/node_modules/playwright:
	@mkdir -p $(TOOLS_DIR)
	@npm install --prefix $(TOOLS_DIR) --no-save --no-package-lock --no-fund --no-audit $(PLAYWRIGHT_PKG)

$(BIN_DIR):
	mkdir -p $(BIN_DIR)

build: $(BIN_DIR)
	$(GO) build $(GOFLAGS) -ldflags '$(LDFLAGS)' -o $(BIN) $(CMD)

run: assets build
	$(BIN) -web web -addr :8080

docker:
	docker build \
		--build-arg VERSION=$(VERSION) \
		--build-arg REVISION=$$(git rev-parse HEAD 2>/dev/null || echo local) \
		--build-arg CREATED=$$(date -u +%Y-%m-%dT%H:%M:%SZ) \
		-t $(IMAGE) \
		-t $(APP):$(VERSION) \
		.

docker-push:
	docker buildx build \
		--platform $(PLATFORMS) \
		--build-arg VERSION=$(VERSION) \
		--build-arg REVISION=$$(git rev-parse HEAD 2>/dev/null || echo local) \
		--build-arg CREATED=$$(date -u +%Y-%m-%dT%H:%M:%SZ) \
		-t $(IMAGE) \
		-t ghcr.io/quad4-software/$(APP):latest \
		--push \
		.

badges:
	@VERSION=$(VERSION) bash scripts/gen-badges.sh

test-go:
	$(GO) test $(GOFLAGS) ./...

test-js:
	$(NODE) --test \
		web/js/engine/pairs.test.mjs \
		web/js/engine/align.test.mjs \
		web/js/engine/incremental.test.mjs \
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
	rm -rf $(BIN_DIR) $(TOOLS_DIR)
