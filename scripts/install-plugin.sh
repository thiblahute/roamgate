#!/bin/sh
set -eu

plugin_root="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
version="$(awk -F '"' '/^version = "/ { print $2; exit }' "$plugin_root/herdr-plugin.toml")"
printf '%s\n' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || {
  printf 'Roamgate plugin: invalid manifest version\n' >&2
  exit 1
}

mkdir -p "$plugin_root/server"
staging="$(mktemp -d "$plugin_root/server/.plugin-install.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
trap 'exit 1' HUP INT TERM

ROAMGATE_VERSION="$version" ROAMGATE_INSTALL_DIR="$staging" \
  sh "$plugin_root/scripts/install-roamgate.sh"
if ! native_version="$("$staging/roamgate" plugin version)" ||
  [ "$native_version" != "roamgate $version" ]; then
  printf 'Roamgate plugin: this release has no native plugin commands. Build an unreleased checkout with `bun scripts/studio-plugin.ts build-source`, then `herdr plugin link .`, or select a published tag that includes native plugin support.\n' >&2
  exit 1
fi
target="$plugin_root/server/roamgate"
# The Pi sidecar beside the binary, when the release has one.
pi_target="$plugin_root/server/roamgate-pi"
for path in "$target" "$pi_target"; do
  if { [ -e "$path" ] || [ -L "$path" ]; } &&
    { [ ! -f "$path" ] || [ -L "$path" ]; }; then
    printf 'Roamgate plugin: install target is not a regular file\n' >&2
    exit 1
  fi
done
if [ -f "$staging/roamgate-pi" ]; then
  mv -f "$staging/roamgate-pi" "$pi_target"
else
  rm -f "$pi_target"
fi
mv -f "$staging/roamgate" "$target"
printf 'Installed Roamgate plugin binary %s\n' "$version"
