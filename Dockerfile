# Build Vylk and package it for the selected Linux architecture.

FROM --platform=$BUILDPLATFORM golang:1.25-alpine AS build

ARG TARGETOS=linux
ARG TARGETARCH
ARG VERSION
ARG GIT_SHA=unknown

WORKDIR /build
COPY go.mod go.sum ./
RUN go mod download
COPY . .

RUN apk add --no-cache python3

RUN mkdir -p /build/release \
    && if [ "${TARGETARCH}" = "amd64" ]; then \
        VERSION="${VERSION}" python3 build.py --all --output-dir /build/release \
        && cp "/build/release/vylk_${TARGETOS}_${TARGETARCH}_${VERSION}" /build/vylk; \
    else \
        VERSION="${VERSION}" python3 build.py \
            --target-os "${TARGETOS}" \
            --target-arch "${TARGETARCH}" \
            --output /build/vylk; \
    fi

FROM debian:bookworm AS package

ARG VERSION
ARG TARGETARCH
ARG INCLUDE_APPIMAGE=0

ENV VERSION="${VERSION}" \
    TARGETARCH="${TARGETARCH}" \
    INCLUDE_APPIMAGE="${INCLUDE_APPIMAGE}" \
    PACKAGE_ROOT=/build \
    OUTPUT_DIR=/output

RUN apt-get update \
    && apt-get install --no-install-recommends -y \
       dpkg-dev \
       python3 \
       rpm \
       tar \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /build
COPY --from=build /build/vylk ./vylk
COPY --from=build /build/release ./release
COPY VERSION release.toml ./
COPY yesb/package.py ./yesb/package.py

RUN python3 yesb/package.py \
    && cp -a /build/release/. /output/

FROM scratch

COPY --from=package /output /
