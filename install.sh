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
INSTALL_WARDEN=0
BINARY_STAGE=""
LIB_COMMITTED=0
WARDEN_LIB_PARENT=""
WARDEN_LIB_ROOT=""
WARDEN_NEW_ROOT=""
WARDEN_OLD_ROOT=""

die() {
	printf 'vsys install: %s\n' "$1" >&2
	exit 1
}

case "$(uname -s)" in
Linux) ;;
Darwin) die "os=Darwin unsupported
vsys reads Linux process and cgroup files. macOS is not supported." ;;
*) die "os=$(uname -s) unsupported
vsys runs on Linux only. This system reports $(uname -s)." ;;
esac

case "$(uname -m)" in
x86_64 | amd64) ARCH="x86_64" ;;
aarch64 | arm64) ARCH="aarch64" ;;
*) die "arch=$(uname -m) unsupported
There is no vsys build for $(uname -m). Build from source: https://github.com/${REPO}" ;;
esac

if ! command -v flock >/dev/null 2>&1; then
	die "command=flock missing
vsys needs flock from util-linux to save filesystem error times. Install util-linux before installing vsys."
fi

if command -v curl >/dev/null 2>&1; then
	fetch() { curl -fsSL "$1" -o "$2"; }
	fetch_stdout() { curl -fsSL "$1"; }
elif command -v wget >/dev/null 2>&1; then
	fetch() { wget -qO "$2" "$1"; }
	fetch_stdout() { wget -qO- "$1"; }
else
	die "command=curl,wget missing
This installer needs curl or wget on PATH."
fi

if command -v sha256sum >/dev/null 2>&1; then
	checksum() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
	checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
	die "command=sha256sum,shasum missing
This installer needs sha256sum or shasum to verify the download."
fi

make_work_dir() {
	mkdir -p "$WORK_PARENT" ||
		die "scratch=mkdir-failed dir=${WORK_PARENT}
Could not create ${WORK_PARENT} for installer scratch files."
	WORK_DIR=$(mktemp -d "${WORK_PARENT}/install.XXXXXX") ||
		die "scratch=mktemp-failed dir=${WORK_PARENT}
Could not create a scratch path under ${WORK_PARENT}."
}

cleanup() {
	rm -rf "$TMP"
	if [ -n "$BINARY_STAGE" ]; then
		rm -f "$BINARY_STAGE"
	fi
	if [ -n "$WARDEN_NEW_ROOT" ] && [ -e "$WARDEN_NEW_ROOT" ]; then
		rm -rf "$WARDEN_NEW_ROOT"
	fi
}

require_archive_file() {
	path="$1"
	mode="$2"
	[ -f "${TMP}/${path}" ] || die "archive=${path} missing
The archive holds no ${path}."
	if [ -L "${TMP}/${path}" ]; then
		die "archive=${path} symlink
The archive holds ${path} as a symlink; refusing to install."
	fi
	case "$mode" in
	x) [ -x "${TMP}/${path}" ] || die "archive=${path} not-executable
The archive holds ${path} without executable mode." ;;
	r) [ -r "${TMP}/${path}" ] || die "archive=${path} not-readable
The archive holds ${path} without readable mode." ;;
	esac
}

validate_archive_payload() {
	require_archive_file "vsys" x
	if [ ! -e "${TMP}/lib/vsys" ]; then
		if [ -e "${TMP}/lib" ]; then
			die "archive=lib partial
The archive holds a partial lib tree without lib/vsys."
		fi
		INSTALL_WARDEN=0
		return
	fi
	INSTALL_WARDEN=1
	require_archive_file "lib/vsys/warden/install" x
	require_archive_file "lib/vsys/warden/agent-warden" x
	require_archive_file "lib/vsys/warden/agent-confine" x
	require_archive_file "lib/vsys/warden/agent-confine-lineage-capped" x
	require_archive_file "lib/vsys/warden/systemd/agent-warden.service" r
	require_archive_file "lib/vsys/warden/systemd/agent-warden.timer" r
	require_archive_file "lib/vsys/warden/systemd/agents.slice" r
	require_archive_file "lib/vsys/data/agent-tools.json" r
}

stage_binary() {
	mkdir -p "$INSTALL_DIR" ||
		die "install-dir=${INSTALL_DIR} mkdir-failed
Could not create ${INSTALL_DIR}. Set VSYS_INSTALL_DIR to a writable directory."
	INSTALL_DIR=$(cd "$INSTALL_DIR" && pwd -P) ||
		die "install-dir=${INSTALL_DIR} resolve-failed
Could not resolve ${INSTALL_DIR}."
	PREFIX=$(dirname "$INSTALL_DIR")
	BINARY_STAGE="${INSTALL_DIR}/.vsys.new.$$"
	[ ! -e "$BINARY_STAGE" ] || die "stage=${BINARY_STAGE} exists
The staging path ${BINARY_STAGE} already exists."
	install -m 755 "${TMP}/vsys" "$BINARY_STAGE" ||
		die "stage=${BINARY_STAGE} write-failed
Could not write to ${INSTALL_DIR}. Set VSYS_INSTALL_DIR to a writable directory."
}

prepare_lib_tree() {
	prefix="$1"
	source_root="${TMP}/lib/vsys"
	WARDEN_LIB_PARENT="${prefix}/lib"
	WARDEN_LIB_ROOT="${WARDEN_LIB_PARENT}/vsys"
	WARDEN_NEW_ROOT="${WARDEN_LIB_PARENT}/.vsys.new.$$"
	WARDEN_OLD_ROOT="${WARDEN_LIB_PARENT}/.vsys.old.$$"

	[ -d "$source_root" ] || die "archive=lib/vsys missing
The archive holds no lib/vsys tree."
	symlink=$(find "$source_root" -type l -print -quit) ||
		die "archive=lib/vsys inspect-failed
Could not inspect the archive lib/vsys tree."
	[ -z "$symlink" ] || die "archive=lib/vsys contains-symlink path=${symlink}
The archive lib/vsys tree contains a symlink: ${symlink}"

	for lib_path in "$WARDEN_LIB_PARENT" "$WARDEN_LIB_ROOT"; do
		[ ! -L "$lib_path" ] || die "lib=${lib_path} symlink
Refusing to replace the symlink ${lib_path}."
	done
	if [ -e "$WARDEN_LIB_ROOT" ] && [ ! -d "$WARDEN_LIB_ROOT" ]; then
		die "lib=${WARDEN_LIB_ROOT} not-directory
${WARDEN_LIB_ROOT} exists and is not a directory."
	fi
	mkdir -p "$WARDEN_LIB_PARENT" ||
		die "lib=${WARDEN_LIB_PARENT} mkdir-failed
Could not create ${WARDEN_LIB_PARENT}."
	[ ! -e "$WARDEN_NEW_ROOT" ] || die "stage=${WARDEN_NEW_ROOT} exists
The staging path ${WARDEN_NEW_ROOT} already exists."
	[ ! -e "$WARDEN_OLD_ROOT" ] || die "old-tree=${WARDEN_OLD_ROOT} exists
The old-tree path ${WARDEN_OLD_ROOT} already exists."
	mkdir "$WARDEN_NEW_ROOT" ||
		die "stage=${WARDEN_NEW_ROOT} mkdir-failed
Could not create ${WARDEN_NEW_ROOT}."
	cp -R --no-preserve=ownership "${source_root}/." "$WARDEN_NEW_ROOT/" ||
		die "stage=${WARDEN_NEW_ROOT} copy-failed
Could not stage the warden files under ${WARDEN_NEW_ROOT}."
	chmod -R u=rwX,go=rX "$WARDEN_NEW_ROOT" ||
		die "stage=${WARDEN_NEW_ROOT} chmod-failed
Could not set warden file modes under ${WARDEN_NEW_ROOT}."
}

rollback_lib_tree() {
	if [ "$LIB_COMMITTED" -eq 1 ]; then
		rm -rf -- "$WARDEN_LIB_ROOT"
		if [ -e "$WARDEN_OLD_ROOT" ]; then
			mv -T -- "$WARDEN_OLD_ROOT" "$WARDEN_LIB_ROOT" || true
		fi
	fi
}

commit_lib_tree() {
	[ "$INSTALL_WARDEN" -eq 1 ] || return 0
	if [ -e "$WARDEN_LIB_ROOT" ]; then
		mv -T -- "$WARDEN_LIB_ROOT" "$WARDEN_OLD_ROOT" ||
			die "lib=${WARDEN_LIB_ROOT} move-aside-failed
Could not move the previous ${WARDEN_LIB_ROOT} aside."
	fi
	if ! mv -T -- "$WARDEN_NEW_ROOT" "$WARDEN_LIB_ROOT"; then
		if [ -e "$WARDEN_OLD_ROOT" ] && [ ! -e "$WARDEN_LIB_ROOT" ]; then
			mv -T -- "$WARDEN_OLD_ROOT" "$WARDEN_LIB_ROOT" || true
		fi
		die "lib=${WARDEN_LIB_ROOT} replace-failed
Could not replace ${WARDEN_LIB_ROOT}."
	fi
	LIB_COMMITTED=1
}

commit_binary() {
	if ! mv -T -- "$BINARY_STAGE" "${INSTALL_DIR}/vsys"; then
		rollback_lib_tree
		die "binary=${INSTALL_DIR}/vsys replace-failed
Could not replace ${INSTALL_DIR}/vsys."
	fi
	BINARY_STAGE=""
	if [ "$LIB_COMMITTED" -eq 1 ] && [ -e "$WARDEN_OLD_ROOT" ]; then
		if ! rm -rf -- "$WARDEN_OLD_ROOT"; then
			printf 'vsys install: warning=old-tree-left path=%s\n' "$WARDEN_OLD_ROOT" >&2
		fi
	fi
}

VERSION="${VSYS_VERSION:-}"
if [ -z "$VERSION" ]; then
	if ! VERSION=$(fetch_stdout "https://api.github.com/repos/${REPO}/releases/latest" |
		sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1); then
		die "lookup=latest-release failed
Could not reach GitHub to read the latest release tag."
	fi
	[ -n "$VERSION" ] || die "lookup=latest-release empty repo=${REPO}
GitHub reported no latest release for ${REPO}."
fi

ASSET="vsys-${VERSION}-linux-${ARCH}.tar.gz"
BASE="https://github.com/${REPO}/releases/download/${VERSION}"

make_work_dir
TMP="$WORK_DIR"
trap cleanup EXIT INT TERM

printf 'Downloading vsys %s for linux-%s\n' "$VERSION" "$ARCH"
fetch "${BASE}/${ASSET}" "${TMP}/${ASSET}" ||
	die "download=${ASSET} failed release=${VERSION}
Release ${VERSION} publishes no ${ASSET}."
fetch "${BASE}/SHA256SUMS" "${TMP}/SHA256SUMS" ||
	die "download=SHA256SUMS failed release=${VERSION}
Release ${VERSION} publishes no SHA256SUMS; refusing to install unverified."

SUM=$(checksum "${TMP}/${ASSET}")
if ! EXPECTED=$(sed -n "s/^\([0-9a-f]\{64\}\)[[:space:]]\+\*\?${ASSET}\$/\1/p" "${TMP}/SHA256SUMS"); then
	die "read=SHA256SUMS failed
Could not read SHA256SUMS."
fi
[ -n "$EXPECTED" ] || die "checksum=${ASSET} unlisted
SHA256SUMS names no checksum for ${ASSET}."
[ "$SUM" = "$EXPECTED" ] || die "checksum=${ASSET} mismatch
The download of ${ASSET} does not match the release's checksum; nothing was installed."

tar -xzf "${TMP}/${ASSET}" -C "$TMP"
validate_archive_payload
stage_binary
if [ "$INSTALL_WARDEN" -eq 1 ]; then
	prepare_lib_tree "$PREFIX"
fi
commit_lib_tree
commit_binary

printf 'Installed vsys %s to %s/vsys\n' "$VERSION" "$INSTALL_DIR"
if [ "$INSTALL_WARDEN" -eq 1 ]; then
	printf 'Installed the warden files to %s/lib/vsys/warden\n' "$PREFIX"
	if ! command -v python3 >/dev/null 2>&1; then
		printf 'The optional warden needs python3 on PATH before you run: vsys warden install\n'
	fi
	printf 'Optional warden setup: vsys warden install\n'
else
	printf 'This release does not include the optional warden.\n'
fi

case ":${PATH}:" in
*":${INSTALL_DIR}:"*) printf 'Run: vsys\n' ;;
*)
	printf '\n%s is not on your PATH. Add this line to your shell profile:\n' "$INSTALL_DIR"
	printf '    export PATH="%s:$PATH"\n' "$INSTALL_DIR"
	printf 'Until then, run: %s/vsys\n' "$INSTALL_DIR"
	if [ "$INSTALL_WARDEN" -eq 1 ]; then
		printf 'Until then, install the optional warden with: %s/vsys warden install\n' "$INSTALL_DIR"
	fi
	;;
esac
