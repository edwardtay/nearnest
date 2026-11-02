#!/usr/bin/env bash
# Reproducible wasm build without cargo-near. `--cfg near` selects near-sdk's on-chain
# code paths (panic_utf8 for readable errors); `-s` strips symbols.
set -euo pipefail
cd "$(dirname "$0")"
RUSTFLAGS="--cfg near -C link-arg=-s" cargo build --target wasm32-unknown-unknown --release
ls -l target/wasm32-unknown-unknown/release/nearnest_vault.wasm
sha256sum target/wasm32-unknown-unknown/release/nearnest_vault.wasm
