#!/bin/sh
# Builds the voice helper for Linux with CUDA, in a container with the CUDA
# toolkit (Containerfile), with Podman:
#
#   voice/helper/linux/build.sh [--test] [output directory]
#
# The output directory (voice/helper/target/linux-cuda by default) gets the
# roamgate-voice binary and, in lib/, the CUDA libraries it is linked with,
# where it finds them: install the directory as a whole. The host needs only
# the NVIDIA driver. With --test, `cargo test --release` runs first, with the
# GPU (CDI's nvidia.com/gpu=all), whose driver library the binary loads.
#
# CUDA_COMPUTE_CAP (86 for an RTX 3060) sets the GPU code built, the host
# GPU's by default. The image (roamgate-voice-build) and the volume holding
# Cargo's downloads and build (roamgate-voice-build-cache) are kept between
# builds; ROAMGATE_VOICE_BUILD_IMAGE and ROAMGATE_VOICE_BUILD_CACHE rename
# them.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
helper=$(dirname "$here")
image=${ROAMGATE_VOICE_BUILD_IMAGE:-roamgate-voice-build}
cache=${ROAMGATE_VOICE_BUILD_CACHE:-roamgate-voice-build-cache}
test=
if [ "${1:-}" = --test ]; then
    test=1
    shift
fi
out=${1:-$helper/target/linux-cuda}
cap=${CUDA_COMPUTE_CAP:-$(nvidia-smi --query-gpu=compute_cap --format=csv,noheader | head -n 1 | tr -d .)}

mkdir -p "$out"
out=$(cd "$out" && pwd)
podman build -t "$image" "$here"
podman volume exists "$cache" || podman volume create "$cache" >/dev/null

# whisper-rs passes CMAKE_* variables on to whisper.cpp's CMake. The build
# directory is not under the project: system-deps is told where its
# manifest (the bundle, the plugins) is.
podman run --rm --security-opt label=disable \
    ${test:+--device nvidia.com/gpu=all} \
    -v "$helper:/src:ro" -v "$cache:/cache" -v "$out:/out" \
    -e CUDA_COMPUTE_CAP="$cap" -e CMAKE_CUDA_ARCHITECTURES="$cap" \
    -e SYSTEM_DEPS_BUILD_MANIFEST=/src/Cargo.toml -e TEST="$test" \
    "$image" sh -euc '
        cd /src
        if [ -n "$TEST" ]; then cargo test --release --locked; fi
        cargo build --release --locked
        bin=$CARGO_TARGET_DIR/release/roamgate-voice
        rm -rf /out/lib && mkdir -p /out/lib
        # The toolkit libraries it needs, by the names it asks for, and the
        # one NVRTC loads if it needs NVRTC; libcuda comes with the host
        # driver.
        ldd "$bin" | awk "index(\$3, \"/usr/local/cuda\") == 1 { print \$1, \$3 }" |
            while read -r name path; do cp -L "$path" "/out/lib/$name"; done
        if ls /out/lib/libnvrtc.so.* >/dev/null 2>&1; then
            builtins=$(readlink -f /usr/local/cuda/lib64/libnvrtc-builtins.so)
            cp "$builtins" "/out/lib/$(objdump -p "$builtins" | awk "/SONAME/ { print \$2 }")"
        fi
        cp "$bin" /out/roamgate-voice
    '
echo "$out/roamgate-voice, with $(ls "$out/lib" | wc -l) libraries in $out/lib"
