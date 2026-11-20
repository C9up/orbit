#!/usr/bin/env bash
# Builds orbit-host as a static library per Android ABI into
# android/libs/<abi>/liborbit_host.a, which the app's native library links
# (see android/orbit.cmake). Until `ream` builds mobile apps, an app runs
# this before its Gradle build.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
NDK="${ANDROID_NDK_HOME:-$HOME/Android/Sdk/ndk/27.1.12297006}"
API=24
BIN="$NDK/toolchains/llvm/prebuilt/linux-x86_64/bin"
CARGO="${CARGO:-cargo}"
export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$HERE/target}"
ABIS="${ABIS:-arm64-v8a x86_64}"

declare -A TRIPLES=([x86_64]=x86_64-linux-android [arm64-v8a]=aarch64-linux-android)

for abi in $ABIS; do
  triple="${TRIPLES[$abi]}"
  env_triple="$(echo "$triple" | tr 'a-z-' 'A-Z_')"
  export "CARGO_TARGET_${env_triple}_LINKER=$BIN/${triple}${API}-clang"
  export "CC_${triple//-/_}=$BIN/${triple}${API}-clang"
  export "AR_${triple//-/_}=$BIN/llvm-ar"
  "$CARGO" build --release --manifest-path "$HERE/crates/orbit-host/Cargo.toml" --target "$triple"
  mkdir -p "$HERE/android/libs/$abi"
  cp "$CARGO_TARGET_DIR/$triple/release/liborbit_host.a" "$HERE/android/libs/$abi/"
done
