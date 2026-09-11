#!/usr/bin/env bash
# Publish the repository's Arch recipe to its AUR repository.
#
# Usage: scripts/publish-aur.sh [--dry-run] [package...]
#
# --dry-run: show proposed changes without committing or pushing.
# -h, --help: print this help.
#
# Packages: vsys-view-git.
# Without package arguments, process all supported packages.
#
# A normal run commits changed recipe files and pushes them to the AUR.
# Publishing needs an AUR account with commit rights and its SSH key.
# Dry runs clone public repositories over HTTPS.
# PKGBUILD and .SRCINFO must agree before publication.
# A git+ source resolves at build time, so it never defers publication.
# An absent release archive defers the affected package.
# Archive checksum mismatches also defer publication.
# Network and metadata errors fail the run.
# Edit recipes here; publication overwrites direct AUR edits.
# Published packages receive a remote synchronization check.
set -euo pipefail

root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"

dry_run=0
packages=()
for argument in "$@"; do
  case "$argument" in
    --dry-run) dry_run=1 ;;
    -h|--help) sed -n '2,21p' "${BASH_SOURCE[0]}"; exit 0 ;;
    -*) echo "publish-aur: unknown option $argument" >&2; exit 2 ;;
    *) packages+=("$argument") ;;
  esac
done
if [[ ${#packages[@]} -eq 0 ]]; then
  packages=(vsys-view-git)
fi

directory_for() {
  case "$1" in
    vsys-view-git) echo "packaging/arch/vsys-view-git" ;;
    *) echo "publish-aur: no in-repo recipe for '$1'" >&2; return 1 ;;
  esac
}

files_for() {
  case "$1" in
    vsys-view-git) echo "PKGBUILD .SRCINFO" ;;
  esac
}

# AUR clients read .SRCINFO, so it must agree with PKGBUILD before publication.
"$root/scripts/check-aur-sync.py"

revision="$(git -C "$root" rev-parse --short HEAD)"
message="sync from vanillagreencom/vsys $revision"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Publish only when source URLs resolve. A missing release defers publication;
# a transport or inspection failure must fail instead of pretending the release is absent.
# check-aur-sync.py lists only http(s) sources: a git+ source is cloned by makepkg
# at build time and needs no release, so a package with none is always available.
# Return 0 for available sources, 1 for HTTP 404/410, and 2 for an inconclusive check.
sources_exist() {
  local package="$1" url sources code rc

  if ! sources="$("$root/scripts/check-aur-sync.py" --print-sources "$package")"; then
    echo "publish-aur: cannot read the source URLs of $package, so whether they resolve is unknown." >&2
    return 2
  fi

  if [[ -z "$sources" ]]; then
    echo "publish-aur: $package has only git+ sources, which makepkg clones at build time; nothing to check for."
    return 0
  fi

  while IFS= read -r url; do
    [[ -n "$url" ]] || continue
    # Capture curl failure in a conditional assignment so errexit cannot skip status classification.
    rc=0
    code="$(curl -sSL --head --max-time 30 --retry 2 -o /dev/null -w '%{http_code}' "$url")" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
      echo "publish-aur: cannot reach $url (curl exit $rc), so whether $package's source exists is unknown." >&2
      echo "publish-aur: not treating an unreachable host as a missing release; that would skip the publish and leave the AUR stale with a green run." >&2
      return 2
    fi
    case "$code" in
      2??) ;;
      404|410)
        echo "publish-aur: $package is NOT published: its source $url returned $code." >&2
        echo "publish-aur: that is expected between a version bump and its release; publish again once the archive is up. If no release is pending, the source URL is wrong." >&2
        return 1
        ;;
      *)
        echo "publish-aur: $url returned $code, which is neither a working source nor a missing one." >&2
        echo "publish-aur: failing rather than guessing; a 403 or a 5xx is a fault to look at, not a release that has not happened yet." >&2
        return 2
        ;;
    esac
  done <<< "$sources"
  return 0
}

# Available archives can still disagree with recipe checksums. Compare the published SHA256SUMS
# before publication. A mismatch defers the package; an unreadable checksum list fails.
# A package with only git+ sources declares no archive checksum and passes.
checksums_match() {
  local package="$1" pairs url digest sums_url sums code rc name

  if ! pairs="$("$root/scripts/check-aur-sync.py" --print-source-checksums "$package")"; then
    echo "publish-aur: cannot read the declared checksums of $package, so whether they are current is unknown." >&2
    return 2
  fi

  while IFS=$'\t' read -r url digest; do
    [[ -n "$url" ]] || continue
    sums_url="${url%/*}/SHA256SUMS"
    rc=0
    sums="$(curl -sSL --max-time 30 --retry 2 -w '\n%{http_code}' "$sums_url")" || rc=$?
    if [[ "$rc" -ne 0 ]]; then
      echo "publish-aur: cannot reach $sums_url (curl exit $rc), so whether $package's checksums are current is unknown." >&2
      return 2
    fi
    code="${sums##*$'\n'}"
    sums="${sums%$'\n'*}"
    if [[ "$code" != 2?? ]]; then
      echo "publish-aur: $sums_url returned $code; refusing to publish $package without reading the release's own checksums." >&2
      return 2
    fi

    name="${url##*/}"
    # Match the full filename so a prefix cannot select another archive checksum.
    if ! echo "$sums" | awk -v want="$digest" -v file="$name" '
      { published = $1; sub(/^\*/, "", $2) }
      $2 == file { found = 1; if (published == want) ok = 1 }
      END { exit (found && ok) ? 0 : 1 }
    '; then
      echo "publish-aur: $package declares a sha256 for $name that the release does not publish." >&2
      echo "publish-aur: that is the state between a version bump and its checksum pin. Pin the sums from $sums_url and publish again; shipping this recipe would fail makepkg's validity check for every user." >&2
      return 1
    fi
  done <<< "$pairs"
  return 0
}

status=0
published=()
for package in "${packages[@]}"; do
  source_dir="$root/$(directory_for "$package")"
  clone="$tmp/$package"

  sources_exist "$package" || case "$?" in
    1) continue ;;          # Release publication owns this deferred package.
    *) status=1; continue ;;
  esac

  checksums_match "$package" || case "$?" in
    1) continue ;;
    *) status=1; continue ;;
  esac

  if [[ "$dry_run" -eq 1 ]]; then
    remote="https://aur.archlinux.org/$package.git"
  else
    remote="ssh://aur@aur.archlinux.org/$package.git"
  fi

  # The AUR answers a name nobody has pushed with an empty repository, over
  # HTTPS and over SSH alike, and the first push to it creates the package.
  if ! git clone --quiet "$remote" "$clone" 2>"$tmp/clone.err"; then
    cat "$tmp/clone.err" >&2
    echo "publish-aur: cannot clone $remote; NOTHING was published for $package" >&2
    status=1
    continue
  fi
  if ! git -C "$clone" rev-parse --verify --quiet HEAD >/dev/null; then
    echo "publish-aur: $package is not yet published; its AUR repository is empty, and the first push creates it."
  fi

  for file in $(files_for "$package"); do
    install -m 644 "$source_dir/$file" "$clone/$file"
  done

  # Intent-to-add includes new files in git diff and dry-run output.
  # Without it, matching tracked metadata could conceal a missing file.
  git -C "$clone" add --intent-to-add --all

  if git -C "$clone" diff --quiet --exit-code; then
    echo "publish-aur: $package is already what this repo holds"
    published+=("$package")
    continue
  fi

  echo "publish-aur: $package changes"
  git -C "$clone" --no-pager diff --stat

  if [[ "$dry_run" -eq 1 ]]; then
    git -C "$clone" --no-pager diff
    echo "publish-aur: --dry-run, so $package was NOT pushed"
    continue
  fi

  git -C "$clone" add --all
  # AUR pushes require a committer identity. CI callers supply it with AUR_COMMIT_NAME and AUR_COMMIT_EMAIL.
  identity=()
  if ! git -C "$clone" config user.email >/dev/null; then
    identity=(
      -c "user.name=${AUR_COMMIT_NAME:-vsys packaging}"
      -c "user.email=${AUR_COMMIT_EMAIL:-packaging@vanillagreen}"
    )
  fi
  git -C "$clone" "${identity[@]}" commit --quiet -m "$message"
  git -C "$clone" push --quiet origin HEAD:master
  echo "publish-aur: pushed $package ($message)"
  published+=("$package")
done

# Verify only packages published by this run; deliberately deferred packages can still differ remotely.
if [[ "$dry_run" -eq 0 && ${#published[@]} -gt 0 ]]; then
  "$root/scripts/check-aur-sync.py" --remote "${published[@]}" || status=1
fi

exit "$status"
