#!/bin/bash
# Push one packaging recipe to the AUR.
#
#   packaging/publish-aur.sh vsys 0.9.0    release package, pinned to a version
#   packaging/publish-aur.sh vsys-git      git package, version read from the checkout
#
# Needs AUR_SSH_PRIVATE_KEY in the environment, and makepkg on PATH. Run it
# from a checkout of the revision being published: the -git package reads its
# pkgver from that checkout, because `makepkg --printsrcinfo` neither fetches
# the VCS source nor runs pkgver().

set -euo pipefail

pkgname="${1:?usage: publish-aur.sh <pkgname> [pkgver]}"
pkgver="${2:-}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
recipe="${repo_root}/packaging/${pkgname}/PKGBUILD"

fail() {
	echo "::error::$1"
	exit 1
}

[ -f "$recipe" ] || fail "No recipe at ${recipe}"
if [ -z "${AUR_SSH_PRIVATE_KEY:-}" ]; then
	fail "AUR_SSH_PRIVATE_KEY is not set"
fi

# A fixed-version package ships checksums, so it may never be published from
# the template's SKIP placeholders.
case "$pkgname" in
*-git) ;;
*)
	if [ -z "$pkgver" ]; then
		fail "${pkgname} is a fixed-version package; pass the version to publish"
	fi
	;;
esac

# makepkg refuses to run as root, so do the work as an unprivileged user.
if [ "$(id -u)" -eq 0 ]; then
	id -u builder >/dev/null 2>&1 || useradd -m builder
	chown -R builder "$repo_root"
	exec runuser -u builder -- env \
		AUR_SSH_PRIVATE_KEY="$AUR_SSH_PRIVATE_KEY" \
		HOME=/home/builder \
		"${BASH_SOURCE[0]}" "$@"
fi

# Derive the -git version from this checkout, matching the recipe's pkgver().
if [ -z "$pkgver" ]; then
	cd "$repo_root"
	git rev-parse --git-dir >/dev/null 2>&1 ||
		fail "${repo_root} is not a git checkout, so ${pkgname} has no revision to describe"
	if described=$(git describe --long --tags --abbrev=7 2>/dev/null); then
		pkgver=$(printf '%s' "$described" | sed 's/^v//;s/\([^-]*-g\)/r\1/;s/-/./g')
	else
		pkgver="0.0.0.r$(git rev-list --count HEAD).g$(git rev-parse --short=7 HEAD)"
	fi
	echo "Derived ${pkgname} pkgver ${pkgver} from the checkout."
fi

mkdir -p "${HOME}/.ssh"
printf '%s\n' "$AUR_SSH_PRIVATE_KEY" > "${HOME}/.ssh/aur"
chmod 600 "${HOME}/.ssh/aur"
cat > "${HOME}/.ssh/config" <<EOF
Host aur.archlinux.org
    User aur
    IdentityFile ${HOME}/.ssh/aur
    IdentitiesOnly yes
    StrictHostKeyChecking accept-new
EOF

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git clone "ssh://aur@aur.archlinux.org/${pkgname}.git" "${work}/pkg"
cp "$recipe" "${work}/pkg/PKGBUILD"
cd "${work}/pkg"

# Pin the version. A sed that matched nothing must not pass silently.
sed -i "s/^pkgver=.*/pkgver=${pkgver}/" PKGBUILD
sed -i "s/^pkgrel=.*/pkgrel=1/" PKGBUILD
grep -qx "pkgver=${pkgver}" PKGBUILD || fail "Could not set pkgver in PKGBUILD"

# A fixed-version package must carry the checksums the release published, so
# every SKIP placeholder has to be replaced and none may survive.
case "$pkgname" in
*-git) ;;
*)
	base="https://github.com/vanillagreencom/vsys/releases/download/v${pkgver}"
	curl -fsSL "${base}/SHA256SUMS" -o SHA256SUMS
	for arch in x86_64 aarch64; do
		asset="vsys-v${pkgver}-linux-${arch}.tar.gz"
		sum=$(awk -v a="$asset" '$2 == a || $2 == "*" a {print $1}' SHA256SUMS) ||
			fail "Could not read SHA256SUMS"
		[[ "$sum" =~ ^[0-9a-f]{64}$ ]] ||
			fail "SHA256SUMS names no sha256 checksum for ${asset}"
		sed -i "s/^sha256sums_${arch}=.*/sha256sums_${arch}=('${sum}')/" PKGBUILD
		grep -qx "sha256sums_${arch}=('${sum}')" PKGBUILD ||
			fail "Could not set sha256sums_${arch} in PKGBUILD"
	done
	rm -f SHA256SUMS
	if grep -q "SKIP" PKGBUILD; then
		fail "${pkgname} PKGBUILD still carries a SKIP checksum; refusing to publish"
	fi
	;;
esac

makepkg --printsrcinfo > .SRCINFO
grep -qx "	pkgver = ${pkgver}" .SRCINFO ||
	fail ".SRCINFO does not carry pkgver ${pkgver}"

git config user.name "vsys release"
git config user.email "ai1@vanillagreen.com"
git add PKGBUILD .SRCINFO
if git diff --cached --quiet; then
	echo "The AUR package for ${pkgname} is already at ${pkgver}."
	exit 0
fi
git commit -m "${pkgname} ${pkgver}"
git push origin master
echo "Pushed ${pkgname} ${pkgver} to the AUR."
