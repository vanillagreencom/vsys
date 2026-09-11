#!/usr/bin/env bash
# Install vsys from its GitHub releases.
#
#   curl -fsSL https://raw.githubusercontent.com/vanillagreencom/vsys/main/install.sh | bash
#
# Environment:
#   VSYS_VERSION      Tag to install. Defaults to the latest release.
#   VSYS_INSTALL_DIR  Directory to install into. Defaults to ~/.local/bin.

set -euo pipefail

REPO="vanillagreencom/vsys"
INSTALL_DIR="${VSYS_INSTALL_DIR:-${HOME}/.local/bin}"

die() {
	printf 'vsys install: %s\n' "$1" >&2
	exit 1
}

case "$(uname -s)" in
Linux) ;;
Darwin) die "vsys reads Linux process and cgroup files. macOS is not supported." ;;
*) die "vsys runs on Linux only. This system reports $(uname -s)." ;;
esac

case "$(uname -m)" in
x86_64 | amd64) ARCH="x86_64" ;;
aarch64 | arm64) ARCH="aarch64" ;;
*) die "no vsys build for $(uname -m). Build from source: https://github.com/${REPO}" ;;
esac

if command -v curl >/dev/null 2>&1; then
	fetch() { curl -fsSL "$1" -o "$2"; }
	fetch_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
	fetch() { wget -qO "$2" "$1"; }
	fetch_stdout() { wget -qO- "$1"; }
else
	die "this installer needs curl or wget on PATH."
fi

if command -v sha256sum >/dev/null 2>&1; then
	checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
	checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
	die "this installer needs sha256sum or shasum to verify the download."
fi

VERSION="${VSYS_VERSION:-}"
if [ -z "$VERSION" ]; then
	if ! VERSION=$(fetch_stdout "https://api.github.com/repos/${REPO}/releases/latest" |
		sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1); then
		die "could not reach GitHub to read the latest release tag."
	fi
	[ -n "$VERSION" ] || die "GitHub reported no latest release for ${REPO}."
fi

ASSET="vsys-${VERSION}-linux-${ARCH}.tar.gz"
BASE="https://github.com/${REPO}/releases/download/${VERSION}"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

printf 'Downloading vsys %s for linux-%s\n' "$VERSION" "$ARCH"
fetch "${BASE}/${ASSET}" "${TMP}/${ASSET}" ||
	die "release ${VERSION} publishes no ${ASSET}."
fetch "${BASE}/SHA256SUMS" "${TMP}/SHA256SUMS" ||
	die "release ${VERSION} publishes no SHA256SUMS; refusing to install unverified."

SUM=$(checksum "${TMP}/${ASSET}")
if ! EXPECTED=$(sed -n "s/^\([0-9a-f]\{64\}\)[[:space:]]\+\*\?${ASSET}\$/\1/p" "${TMP}/SHA256SUMS"); then
	die "could not read SHA256SUMS."
fi
[ -n "$EXPECTED" ] || die "SHA256SUMS names no checksum for ${ASSET}."
[ "$SUM" = "$EXPECTED" ] || die "checksum mismatch for ${ASSET}; nothing was installed."

tar -xzf "${TMP}/${ASSET}" -C "$TMP"
[ -f "${TMP}/vsys" ] || die "the archive holds no vsys binary."

mkdir -p "$INSTALL_DIR" ||
	die "could not create ${INSTALL_DIR}. Set VSYS_INSTALL_DIR to a writable directory."
install -m 755 "${TMP}/vsys" "${INSTALL_DIR}/vsys" ||
	die "could not write to ${INSTALL_DIR}. Set VSYS_INSTALL_DIR to a writable directory."

printf 'Installed vsys %s to %s/vsys\n' "$VERSION" "$INSTALL_DIR"

case ":${PATH}:" in
*":${INSTALL_DIR}:"*) printf 'Run: vsys\n' ;;
*)
	printf '\n%s is not on your PATH. Add this line to your shell profile:\n' "$INSTALL_DIR"
	printf '    export PATH="%s:$PATH"\n' "$INSTALL_DIR"
	printf 'Until then, run: %s/vsys\n' "$INSTALL_DIR"
	;;
esac
