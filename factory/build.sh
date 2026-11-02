#!/usr/bin/env bash
# Builds the vault first (the factory embeds its wasm), then the factory.
set -euo pipefail
cd "$(dirname "$0")"
../contract/build.sh >/dev/null
RUSTFLAGS="--cfg near -C link-arg=-s" cargo build --target wasm32-unknown-unknown --release
ls -l target/wasm32-unknown-unknown/release/nearnest_factory.wasm
sha256sum target/wasm32-unknown-unknown/release/nearnest_factory.wasm
