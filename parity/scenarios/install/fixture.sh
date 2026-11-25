#!/bin/sh
# Makes a release the installers download from fake-models: a package
# directory with a fake binary and VERSION, its tar.xz and .sha256, under
# ./served/releases (the run's root is the working directory of `sh:`
# steps; fake-models serves ./served at ${FAKE_HTTP}/files/).
#
# fixture.sh <product> ; variables:
#   ARCHIVE_VERSION the release's version in the archive name (versioned)
#   CHECKSUM_NAME  the file name the .sha256 line gives (default: the archive)
#   DIGEST         the digest the .sha256 line gives (default: the real one)
#   VERSION_FIELD  the version VERSION says (default 9.8.7)
#   PLUGIN_FAILURE the plugin binary's failure (none, native-command,
#                  native-exit)
#   PI_SIDECAR     1: the package has roamgate-pi beside the binary
#   PLATFORM       the release's platform (default: this machine's)
set -eu
product=$1
os=$(uname -s)
arch=$(uname -m)
case "$os" in Linux) os=linux ;; Darwin) os=darwin ;; esac
case "$arch" in x86_64 | amd64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; esac
platform=${PLATFORM:-$os-$arch}
if [ -n "${ARCHIVE_VERSION:-}" ]; then
  archive_name=$product-v$ARCHIVE_VERSION-$platform.tar.xz
else
  archive_name=$product-$platform.tar.xz
fi
assets=$PWD/served/releases
package_dir=$product-$platform
mkdir -p "$assets/$package_dir"
failure=${PLUGIN_FAILURE:-none}
cat >"$assets/$package_dir/$product" <<SCRIPT
#!/bin/sh
if [ "\${1:-}" = "--version" ]; then echo "$product 9.8.7"; exit 0; fi
if [ "\${1:-} \${2:-}" = "plugin version" ] && [ "$failure" != "native-command" ]; then
  echo "$product 9.8.7"; [ "$failure" != "native-exit" ]; exit \$?
fi
exit 1
SCRIPT
chmod 755 "$assets/$package_dir/$product"
printf '%s %s %s\n' "$product" "${VERSION_FIELD:-9.8.7}" "$platform" >"$assets/$package_dir/VERSION"
if [ "${PI_SIDECAR:-}" = 1 ]; then
  printf '#!/bin/sh\necho pi 9.8.7\n' >"$assets/$package_dir/roamgate-pi"
  chmod 755 "$assets/$package_dir/roamgate-pi"
fi
COPYFILE_DISABLE=1 tar -C "$assets" -cJf "$assets/$archive_name" "$package_dir"
if command -v sha256sum >/dev/null; then
  digest=$(sha256sum "$assets/$archive_name" | cut -d' ' -f1)
else
  digest=$(shasum -a 256 "$assets/$archive_name" | cut -d' ' -f1)
fi
printf '%s  %s\n' "${DIGEST:-$digest}" "${CHECKSUM_NAME:-$archive_name}" >"$assets/$archive_name.sha256"
