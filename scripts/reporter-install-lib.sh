# Fetch-and-verify helper shared by the root-side reporter installers
# (scripts/scrub-reporter/install and scripts/smart-reporter/install). An
# installer fetches this file over the same unversioned channel it fetches
# itself from (curl|bash from main), then sources it; only the reporter
# files it goes on to fetch are checksum-verified, against the pinned
# release's own SHA256SUMS. Sourced, never run directly: the caller defines
# die() with its own prefix and sets WORK before sourcing.
set -euo pipefail

REPORTER_REPO="vanillagreencom/vsys"

reporter_checksum_tool() {
	if command -v sha256sum >/dev/null 2>&1; then
		checksum() { sha256sum "$1" | cut -d' ' -f1; }
	elif command -v shasum >/dev/null 2>&1; then
		checksum() { shasum -a 256 "$1" | cut -d' ' -f1; }
	else
		die "this installer needs sha256sum or shasum to verify the download."
	fi
}

# Echoes VSYS_VERSION, or the latest release tag when it is unset.
reporter_resolve_version() {
	local version="${VSYS_VERSION:-}"
	if [[ -z $version ]]; then
		version=$(curl -fsSL "https://api.github.com/repos/${REPORTER_REPO}/releases/latest" |
			sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1) ||
			die "could not reach GitHub to read the latest release tag."
		[[ -n $version ]] || die "GitHub reported no latest release for ${REPORTER_REPO}."
	fi
	printf '%s\n' "$version"
}

# Downloads each named file from $2's release subdirectory under $1's tag,
# into $WORK, after checking it against that release's own SHA256SUMS. Dies,
# installing nothing, on a missing SHA256SUMS or a missing or mismatched
# checksum for any file.
reporter_fetch_verified() {
	local version="$1" subdir="$2"
	shift 2
	local source="https://raw.githubusercontent.com/${REPORTER_REPO}/${version}/scripts/${subdir}"
	local sums_url="https://github.com/${REPORTER_REPO}/releases/download/${version}/SHA256SUMS"

	curl -fsSL "$sums_url" -o "$WORK/SHA256SUMS" ||
		die "release ${version} publishes no SHA256SUMS; refusing to install an unverified reporter."

	local name sum expected
	for name in "$@"; do
		curl -fsSL "$source/$name" -o "$WORK/$name" ||
			die "download=$name failed
Could not fetch $source/$name. Nothing was installed."
		if ! expected=$(sed -n "s/^\([0-9a-f]\{64\}\)[[:space:]]\+\*\?${name}\$/\1/p" "$WORK/SHA256SUMS"); then
			die "could not read SHA256SUMS."
		fi
		[[ -n $expected ]] || die "SHA256SUMS names no checksum for $name; refusing to install unverified."
		if ! sum=$(checksum "$WORK/$name"); then
			die "could not checksum $name."
		fi
		[[ "$sum" == "$expected" ]] || die "checksum mismatch for $name; nothing was installed."
	done
}
