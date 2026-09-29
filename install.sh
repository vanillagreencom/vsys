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
WORK_PARENT="${XDG_CACHE_HOME:-${HOME}/.cache}/vsys"

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

make_work_dir() {
	mkdir -p "$WORK_PARENT" ||
		die "could not create ${WORK_PARENT} for installer scratch files."
	WORK_DIR="${WORK_PARENT}/install.$$"
	[ ! -e "$WORK_DIR" ] ||
		die "scratch path already exists: ${WORK_DIR}"
	mkdir -m 700 "$WORK_DIR" ||
		die "could not create scratch path: ${WORK_DIR}"
}

require_archive_file() {
	path="$1"
	mode="$2"
	[ -f "${TMP}/${path}" ] || die "the archive holds no ${path}."
	if [ -L "${TMP}/${path}" ]; then
		die "the archive holds ${path} as a symlink; refusing to install."
	fi
	case "$mode" in
	x) [ -x "${TMP}/${path}" ] || die "the archive holds ${path} without executable mode." ;;
	r) [ -r "${TMP}/${path}" ] || die "the archive holds ${path} without readable mode." ;;
	esac
}

replace_lib_tree() {
	prefix="$1"
	source_root="${TMP}/lib/vsys"
	lib_parent="${prefix}/lib"
	lib_root="${lib_parent}/vsys"
	new_root="${lib_parent}/.vsys.new.$$"
	old_root="${lib_parent}/.vsys.old.$$"

	[ -d "$source_root" ] || die "the archive holds no lib/vsys tree."
	symlink=$(find "$source_root" -type l -print -quit) ||
		die "could not inspect the archive lib/vsys tree."
	[ -z "$symlink" ] || die "the archive lib/vsys tree contains a symlink: ${symlink}"

	if [ -L "$lib_parent" ] || [ -L "$lib_root" ]; then
		die "refusing to replace symlink under ${lib_parent}"
	fi
	if [ -e "$lib_root" ] && [ ! -d "$lib_root" ]; then
		die "${lib_root} exists and is not a directory."
	fi
	mkdir -p "$lib_parent" ||
		die "could not create ${lib_parent}."
	[ ! -e "$new_root" ] || die "staging path already exists: ${new_root}"
	[ ! -e "$old_root" ] || die "old-tree path already exists: ${old_root}"
	mkdir "$new_root" ||
		die "could not create ${new_root}."
	cp -Rp "${source_root}/." "$new_root/" ||
		die "could not stage the warden files under ${new_root}."
	if [ -e "$lib_root" ]; then
		mv "$lib_root" "$old_root" ||
			die "could not move the previous ${lib_root} aside."
	fi
	if ! mv "$new_root" "$lib_root"; then
		if [ -e "$old_root" ] && [ ! -e "$lib_root" ]; then
			mv "$old_root" "$lib_root" || true
		fi
		die "could not replace ${lib_root}."
	fi
	rm -rf "$old_root"
}

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

make_work_dir
TMP="$WORK_DIR"
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
require_archive_file "vsys" x
require_archive_file "lib/vsys/warden/install" x
require_archive_file "lib/vsys/warden/agent-warden" x
require_archive_file "lib/vsys/warden/agent-confine" x
require_archive_file "lib/vsys/warden/agent-confine-lineage-capped" x
require_archive_file "lib/vsys/warden/systemd/agent-warden.service" r
require_archive_file "lib/vsys/warden/systemd/agent-warden.timer" r
require_archive_file "lib/vsys/warden/systemd/agents.slice" r
require_archive_file "lib/vsys/data/agent-tools.json" r

mkdir -p "$INSTALL_DIR" ||
	die "could not create ${INSTALL_DIR}. Set VSYS_INSTALL_DIR to a writable directory."
INSTALL_DIR=$(cd "$INSTALL_DIR" && pwd -P) ||
	die "could not resolve ${INSTALL_DIR}."
PREFIX=$(dirname "$INSTALL_DIR")
install -m 755 "${TMP}/vsys" "${INSTALL_DIR}/vsys" ||
	die "could not write to ${INSTALL_DIR}. Set VSYS_INSTALL_DIR to a writable directory."
replace_lib_tree "$PREFIX"

printf 'Installed vsys %s to %s/vsys\n' "$VERSION" "$INSTALL_DIR"
printf 'Installed the warden files to %s/lib/vsys/warden\n' "$PREFIX"
if ! command -v python3 >/dev/null 2>&1; then
	printf 'The optional warden needs python3 on PATH before you run: vsys warden install\n'
fi
printf 'Optional warden setup: vsys warden install\n'

case ":${PATH}:" in
*":${INSTALL_DIR}:"*) printf 'Run: vsys\n' ;;
*)
	printf '\n%s is not on your PATH. Add this line to your shell profile:\n' "$INSTALL_DIR"
	printf '    export PATH="%s:$PATH"\n' "$INSTALL_DIR"
	printf 'Until then, run: %s/vsys\n' "$INSTALL_DIR"
	printf 'Until then, install the optional warden with: %s/vsys warden install\n' "$INSTALL_DIR"
	;;
esac
