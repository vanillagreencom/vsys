#!/usr/bin/env bash
# Stage the runtime files that ship beside the vsys binary.

set -euo pipefail

usage() {
	printf 'usage: packaging/stage-runtime-files.sh <stage-root>\n' >&2
	exit 2
}

[ "$#" -eq 1 ] || usage

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "${script_dir}/.." && pwd -P)"
manifest="${script_dir}/vsys-runtime-files.txt"
stage_root="$1"

[ -f "$manifest" ] || {
	printf 'vsys package staging: missing manifest path=%s\n' "$manifest" >&2
	exit 1
}

while read -r mode archive_path source_path extra; do
	case "$mode" in
	"" | \#*) continue ;;
	esac
	[ -z "${extra:-}" ] || {
		printf 'vsys package staging: malformed manifest line=%s %s %s %s\n' "$mode" "$archive_path" "$source_path" "$extra" >&2
		exit 1
	}
	case "$archive_path" in
	/* | *../* | ../* | *'/..' | '..') printf 'vsys package staging: unsafe archive path=%s\n' "$archive_path" >&2; exit 1 ;;
	esac
	case "$source_path" in
	/* | *../* | ../* | *'/..' | '..') printf 'vsys package staging: unsafe source path=%s\n' "$source_path" >&2; exit 1 ;;
	esac
	source="${repo_root}/${source_path}"
	target="${stage_root}/${archive_path}"
	[ -f "$source" ] || {
		printf 'vsys package staging: missing source path=%s\n' "$source_path" >&2
		exit 1
	}
	install -Dm"$mode" "$source" "$target"
done < "$manifest"
