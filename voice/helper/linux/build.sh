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
#
# While GameMode runs (a game; `gamemoded -s`, on the host from a toolbox),
# the build yields the CPU to it: GAME_AWARE=nice (the default) builds at
# the lowest priority (nice 19, idle I/O) with 2 jobs and 2 test threads,
# GAME_AWARE=wait waits for the game to end first, GAME_AWARE=off ignores
# it. Without gamemoded, it builds as usual.
set -eu

# The host-spawn that runs: /usr/bin's or /usr/local/bin's, else the first
# non-empty executable one on PATH (an empty root-owned 0700 one may come
# first there). Prints nothing and fails when none runs.
host_spawn() {
    for candidate in /usr/bin/host-spawn /usr/local/bin/host-spawn; do
        if [ -f "$candidate" ] && [ -s "$candidate" ] && [ -x "$candidate" ]; then
            echo "$candidate"
            return 0
        fi
    done
    (
        IFS=:
        for dir in $PATH; do
            [ -n "$dir" ] || continue
            candidate=$dir/host-spawn
            if [ -f "$candidate" ] && [ -s "$candidate" ] && [ -x "$candidate" ]; then
                echo "$candidate"
                exit 0
            fi
        done
        exit 1
    )
}

# Whether GameMode runs: false when it cannot tell.
game_running() {
    if [ -e /run/.toolboxenv ]; then
        spawn=$(host_spawn) || return 1
        set -- "$spawn" --no-pty gamemoded -s
    else
        set -- gamemoded -s
    fi
    "$@" 2>/dev/null | grep -q "gamemode is active"
}

# The command prefix and jobs of a build yielding the CPU to a game.
yield=
jobs=
case ${GAME_AWARE:-nice} in
off) ;;
wait)
    while game_running; do
        echo "GameMode is active: waiting for the game to end (GAME_AWARE=wait)"
        sleep 60
    done
    ;;
nice)
    if game_running; then
        yield="nice -n 19"
        if command -v ionice >/dev/null 2>&1; then yield="$yield ionice -c3"; fi
        jobs=2
        echo "GameMode is active: building at the lowest priority with $jobs jobs (GAME_AWARE=wait waits for the game to end)"
    fi
    ;;
*)
    echo "GAME_AWARE must be nice, wait or off" >&2
    exit 1
    ;;
esac

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
# The cases some tests read (contract/vectors), where /src/../../ finds
# them in the container.
vectors=$(cd "$helper/../../contract/vectors" && pwd)
$yield podman build -t "$image" "$here"
podman volume exists "$cache" || podman volume create "$cache" >/dev/null

# whisper-rs passes CMAKE_* variables on to whisper.cpp's CMake. The build
# directory is not under the project: system-deps is told where its
# manifest (the bundle, the plugins) is.
$yield podman run --rm --security-opt label=disable \
    -v "$vectors:/contract/vectors:ro" \
    ${test:+--device nvidia.com/gpu=all} \
    ${jobs:+-e CARGO_BUILD_JOBS=$jobs -e RUST_TEST_THREADS=$jobs} \
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
