#!/bin/bash
# Push one packaging recipe to the AUR.
#
#   packaging/publish-aur.sh vsys 0.9.0    release package, pinned to a version
#   packaging/publish-aur.sh vsys-git      git package, version derived by pkgver()
#
# Needs AUR_SSH_PRIVATE_KEY in the environment, and makepkg on PATH.

set -euo pipefail

pkgname="${1:?usage: publish-aur.sh <pkgname> [pkgver]}"
pkgver="${2:-}"
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
recipe="${repo_root}/packaging/${pkgname}/PKGBUILD"

[ -f "$recipe" ] || { echo "::error::No recipe at ${recipe}"; exit 1; }
[ -n "${AUR_SSH_PRIVATE_KEY:-}" ] || { echo "::error::AUR_SSH_PRIVATE_KEY is not set"; exit 1; }

# makepkg refuses to run as root, so do the work as an unprivileged user.
if [ "$(id -u)" -eq 0 ]; then
	id -u builder >/dev/null 2>&1 || useradd -m builder
	chown -R builder "$repo_root"
	exec runuser -u builder -- env \
		AUR_SSH_PRIVATE_KEY="$AUR_SSH_PRIVATE_KEY" \
		HOME=/home/builder \
		"${BASH_SOURCE[0]}" "$@"
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

if [ -n "$pkgver" ]; then
	sed -i "s/^pkgver=.*/pkgver=${pkgver}/" PKGBUILD
	sed -i "s/^pkgrel=.*/pkgrel=1/" PKGBUILD
	# Replace the SKIP placeholders with the checksums the release published.
	base="https://github.com/vanillagreencom/vsys/releases/download/v${pkgver}"
	curl -fsSL "${base}/SHA256SUMS" -o SHA256SUMS
	for arch in x86_64 aarch64; do
		if ! sum=$(awk -v a="vsys-v${pkgver}-linux-${arch}.tar.gz" '$2 == a || $2 == "*" a {print $1}' SHA256SUMS); then
			echo "::error::Could not read SHA256SUMS"
			exit 1
		fi
		[ -n "$sum" ] || { echo "::error::SHA256SUMS names no checksum for ${arch}"; exit 1; }
		sed -i "s/^sha256sums_${arch}=.*/sha256sums_${arch}=('${sum}')/" PKGBUILD
	done
	rm -f SHA256SUMS
fi

makepkg --printsrcinfo > .SRCINFO

git config user.name "vsys release"
git config user.email "brad@vanillagreen.com"
git add PKGBUILD .SRCINFO
if git diff --cached --quiet; then
	echo "The AUR package for ${pkgname} is already current."
	exit 0
fi
git commit -m "${pkgname}: $(awk -F= '/^pkgver=/{print $2}' PKGBUILD)"
git push origin master
echo "Pushed ${pkgname} to the AUR."
