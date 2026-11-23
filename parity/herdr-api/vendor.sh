#!/bin/sh
# Vendors Herdr's control API types (src/api/schema*) at the version Roamgate
# verifies (server/src/herdr/release.ts VERIFIED_HERDR_VERSION) into src/schema*.
# Usage: parity/herdr-api/vendor.sh <herdr checkout> [tag]
# The only edits: paths into the rest of Herdr point at src/compat.rs, and the
# unit tests (which need the whole of Herdr) are left out.
set -eu
herdr=$1
tag=${2:-v$(sed -n 's/^export const VERIFIED_HERDR_VERSION = "\(.*\)";$/\1/p' "$(dirname "$0")/../../server/src/herdr/release.ts")}
out=$(dirname "$0")/src
rm -rf "$out/schema" "$out/schema.rs"
mkdir -p "$out/schema"
rewrite() {
  sed -e 's/crate::agent_resume::/crate::compat::/g' \
      -e 's/crate::config::/crate::compat::/g' \
      -e 's/crate::popup_size::/crate::compat::/g' \
      -e '/^#\[cfg(test)\]$/{N;/\nmod tests;$/d;}'
}
git -C "$herdr" show "$tag:src/api/schema.rs" | rewrite > "$out/schema.rs"
for file in $(git -C "$herdr" ls-tree --name-only "$tag" src/api/schema/); do
  name=$(basename "$file")
  [ "$name" = tests.rs ] && continue
  git -C "$herdr" show "$tag:$file" | rewrite > "$out/schema/$name"
done
# The client-owned shell's endpoint generation 1 (src/protocol/endpoint.rs
# up to its message builders) and, from src/protocol/wire.rs, the shell
# snapshot types and SemanticNotification, which it names.
{
  printf '%s\n' "//! Vendored by vendor.sh from Herdr $tag: src/protocol/endpoint.rs (up to its" \
    "//! message builders) and, from src/protocol/wire.rs, the shell snapshot types" \
    "//! (without their conversions from Herdr's config) and SemanticNotification." \
    "" "#![allow(dead_code)]" "" "use serde::{Deserialize, Serialize};" "" \
    "pub use crate::wire::ClientSurfaceSize;" ""
  git -C "$herdr" show "$tag:src/protocol/endpoint.rs" |
    awk '/^pub fn snapshot_message/ {exit} /^use / {next} /^\/\/!/ {next} {print}'
  git -C "$herdr" show "$tag:src/protocol/wire.rs" |
    awk '/^fn deserialize_client_shell_agent_status/ {on=1}
         /^\/\/\/ Origin-relative geometry for one pane/ {on=0}
         /^impl (From|TryFrom)<.*CustomCommandAction/ {skip=1}
         on && !skip {print}
         skip && /^}/ {skip=0}'
  git -C "$herdr" show "$tag:src/protocol/wire.rs" |
    awk '/^\/\/\/ A client-rendered notification category/ {on=1}
         on {print}
         on && /^pub struct SemanticNotification / {inner=1}
         inner && /^}/ {exit}'
} | sed -e 's/crate::api::schema::/crate::schema::/g' -e 's/crate::config::/crate::compat::/g' > "$(dirname "$0")/src/endpoint.rs"
# The pane surface of endpoint generation 1 (src/protocol/wire.rs): cells,
# frames and the PaneSurface message, without Herdr's ratatui conversions.
{
  printf '%s\n' "//! Vendored by vendor.sh from Herdr $tag: the pane surface types of" \
    "//! src/protocol/wire.rs (without their conversions from ratatui)." \
    "" "#![allow(dead_code)]" "" "use serde::{Deserialize, Serialize};" ""
  git -C "$herdr" show "$tag:src/protocol/wire.rs" |
    awk '/^pub struct TerminalFrame/ {exit}
         /^(#\[derive.*\]|\/\/\/.*)$/ {held = held $0 "\n"; next}
         /^pub struct CellData/ || /^pub struct PaneSurfacePane / {on=1}
         /^impl (CellData|FrameData|From<ratatui)/ {skip=1}
         on && !skip { printf "%s", held; print }
         { held="" }
         skip && /^}/ {skip=0}
         on && /^pub struct FrameData/ {frame=1}
         frame && /^}/ {on=0; frame=0}'
} | sed -e 's/, bincode::Decode//' > "$(dirname "$0")/src/surface.rs"
printf '%s\n' "${tag#v}" > "$(dirname "$0")/HERDR_VERSION"
git -C "$herdr" rev-parse "$tag^{commit}" >> "$(dirname "$0")/HERDR_VERSION"
