# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

# Multi-stage rootless image for translatasm.
# Bases: Chainguard Wolfi latest (go toolchain + wolfi-base runtime).
# Assets stage downloads Bergamot WASM + Marian packs for a full offline image.

ARG VERSION=0.1.0
ARG REVISION=unknown
ARG CREATED=unknown

FROM cgr.dev/chainguard/go:latest AS builder

ARG VERSION
ARG TARGETOS
ARG TARGETARCH

WORKDIR /src

COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal

ENV CGO_ENABLED=0 \
	GOPATH=/go
RUN --mount=type=cache,target=/root/.cache/go-build \
	--mount=type=cache,target=/go/pkg/mod \
	GOOS=${TARGETOS:-linux} GOARCH=${TARGETARCH:-amd64} \
	go build \
		-trimpath \
		-buildvcs=false \
		-ldflags="-s -w -X github.com/Quad4-Software/translatasm/internal/version.Version=${VERSION}" \
		-o /out/translatasm \
		./cmd/translatasm

FROM cgr.dev/chainguard/wolfi-base:latest AS assets

RUN apk add --no-cache go-1.27 curl bash python-3.13 zstd gzip

WORKDIR /src
COPY go.mod ./
COPY cmd ./cmd
COPY internal ./internal
COPY scripts/fetch-assets.sh scripts/fetch-firefox-wasm.sh ./scripts/
COPY web ./web

ARG TRANSLATASM_EXTRAS=1
ARG TRANSLATASM_CJK=0
ARG TRANSLATASM_PAIRS=all

ENV GOPATH=/go \
	GOTOOLCHAIN=auto
RUN --mount=type=cache,target=/root/.cache/go-build \
	--mount=type=cache,target=/go/pkg/mod \
	chmod +x scripts/fetch-assets.sh scripts/fetch-firefox-wasm.sh \
	&& TRANSLATASM_EXTRAS="${TRANSLATASM_EXTRAS}" \
		TRANSLATASM_CJK="${TRANSLATASM_CJK}" \
		TRANSLATASM_PAIRS="${TRANSLATASM_PAIRS}" \
		bash scripts/fetch-assets.sh \
	&& if [ "${TRANSLATASM_CJK}" = "1" ]; then \
		bash scripts/fetch-firefox-wasm.sh; \
	fi \
	&& go run ./cmd/gencatalog -o web/catalog.json

FROM cgr.dev/chainguard/wolfi-base:latest AS runtime

ARG VERSION
ARG REVISION
ARG CREATED

LABEL org.opencontainers.image.title="translatasm" \
	org.opencontainers.image.description="Offline in-browser Bergamot translation via WASM" \
	org.opencontainers.image.version="${VERSION}" \
	org.opencontainers.image.revision="${REVISION}" \
	org.opencontainers.image.created="${CREATED}" \
	org.opencontainers.image.licenses="0BSD" \
	org.opencontainers.image.vendor="translatasm" \
	org.opencontainers.image.source="https://github.com/Quad4-Software/translatasm" \
	org.opencontainers.image.url="https://translatasm.quad4.io" \
	org.opencontainers.image.documentation="https://github.com/Quad4-Software/translatasm" \
	org.opencontainers.image.base.name="cgr.dev/chainguard/wolfi-base:latest" \
	org.opencontainers.image.ref.name="translatasm:${VERSION}"

RUN apk upgrade --no-cache \
	&& apk add --no-cache curl \
	&& mkdir -p /app/web \
	&& chown -R 65532:65532 /app

COPY --from=builder --chown=65532:65532 /out/translatasm /app/translatasm
COPY --from=assets --chown=65532:65532 /src/web /app/web

RUN test -f /app/web/vendor/bergamot/worker/bergamot-translator-worker.wasm \
	&& test -f /app/web/models/registry.json \
	&& test -f /app/web/catalog.json \
	&& chmod 0555 /app/translatasm \
	&& chmod -R a-w /app/web

ENV TRANSLATASM_ADDR=":8080" \
	TRANSLATASM_WEB="/app/web" \
	HOME="/tmp"

WORKDIR /app
USER 65532:65532

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
	CMD curl -fsS -o /dev/null http://127.0.0.1:8080/api/health || exit 1

STOPSIGNAL SIGTERM

ENTRYPOINT ["/app/translatasm"]
CMD ["-addr", ":8080", "-web", "/app/web"]
