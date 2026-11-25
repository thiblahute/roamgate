#!/bin/sh
# Packages a built voice helper for a release, as `roamgate setup voice`
# installs it (crates/roamgate-voice-server/src/helper_release.rs):
#
#   voice/helper/package.sh <helper directory> <platform> <version> <output directory>
#
# The helper directory is what linux/build.sh (or the macOS and Windows
# builds) leave: roamgate-voice (.exe on Windows), lib/ and share/. It
# makes, in the output directory:
# - roamgate-voice-<platform>.tar.xz: the helper, its non-CUDA libraries
#   and share/;
# - roamgate-voice-cuda-<platform>.tar.xz, when lib/ has CUDA files: the
#   CUDA libraries and Whisper's CUDA module, the optional CUDA pack;
# - roamgate-voice-<platform>.json: the manifest naming both, with their
#   sizes and SHA-256.
set -eu

if [ $# -ne 4 ]; then
    echo "usage: $0 <helper directory> <platform> <version> <output directory>" >&2
    exit 2
fi
helper=$(cd "$1" && pwd)
platform=$2
version=$3
mkdir -p "$4"
out=$(cd "$4" && pwd)

sha256() {
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "$1" | cut -d ' ' -f 1
    else
        shasum -a 256 "$1" | cut -d ' ' -f 1
    fi
}

# Whether a file of lib/ belongs to the CUDA pack.
is_cuda() {
    case $1 in
    libcu* | libnvrtc* | libggml-cuda.* | cu*.dll | nvrtc*.dll | ggml-cuda.dll) return 0 ;;
    *) return 1 ;;
    esac
}

stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
mkdir -p "$stage/helper/lib" "$stage/cuda/lib"
for binary in roamgate-voice roamgate-voice.exe; do
    if [ -f "$helper/$binary" ]; then cp "$helper/$binary" "$stage/helper/"; fi
done
if [ -d "$helper/share" ]; then cp -R "$helper/share" "$stage/helper/"; fi
if [ -d "$helper/lib" ]; then
    for file in "$helper"/lib/*; do
        [ -e "$file" ] || continue
        name=$(basename "$file")
        if is_cuda "$name"; then
            cp -R "$file" "$stage/cuda/lib/"
        else
            cp -R "$file" "$stage/helper/lib/"
        fi
    done
fi

archive=roamgate-voice-$platform.tar.xz
cuda_archive=roamgate-voice-cuda-$platform.tar.xz
tar -cJf "$out/$archive" -C "$stage/helper" .
asset() {
    printf '{"archive": "%s", "size": %s, "sha256": "%s"}' \
        "$1" "$(wc -c <"$out/$1" | tr -d ' ')" "$(sha256 "$out/$1")"
}
cuda=null
if [ -n "$(ls "$stage/cuda/lib")" ]; then
    tar -cJf "$out/$cuda_archive" -C "$stage/cuda" .
    cuda=$(asset "$cuda_archive")
fi
printf '{"schema": 1, "name": "roamgate-voice", "version": "%s", "platform": "%s", "helper": %s, "cuda": %s}\n' \
    "$version" "$platform" "$(asset "$archive")" "$cuda" >"$out/roamgate-voice-$platform.json"
cat "$out/roamgate-voice-$platform.json"
