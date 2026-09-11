#!/usr/bin/env python3
"""Compare local AUR recipe metadata and, with --remote, published recipe files.

The local check compares PKGBUILD and .SRCINFO. The remote check requires
network access and compares the published AUR repository with this tree.
Without --remote, the script reports that publication was not checked.
"""

from __future__ import annotations

import argparse
import difflib
import re
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
AUR_REMOTE = "https://aur.archlinux.org"

# Files compared with each published AUR repository.
PACKAGES = {
    "vsys-view-git": ("packaging/arch/vsys-view-git", ("PKGBUILD", ".SRCINFO")),
}

# pkgbase fields compared between PKGBUILD and .SRCINFO. Anything makepkg would
# expand at build time (the package_* bodies are handled separately) stays out.
PKGBASE_KEYS = (
    "pkgdesc",
    "pkgver",
    "pkgrel",
    "url",
    "arch",
    "license",
    "depends",
    "makedepends",
    "checkdepends",
    "optdepends",
    "provides",
    "conflicts",
    "replaces",
    "options",
    "source",
    "sha256sums",
    "b2sums",
    "md5sums",
)
ARCHES = ("x86_64", "aarch64", "i686", "armv7h")
KEYS = PKGBASE_KEYS + tuple(
    f"{key}_{arch}"
    for key in ("source", "sha256sums", "b2sums", "md5sums")
    for arch in ARCHES
)
# Fields a package_* function may override; .SRCINFO repeats them per pkgname.
SPLIT_KEYS = ("pkgdesc", "depends", "optdepends", "provides", "conflicts", "install")


class CheckError(Exception):
    pass


def expand(value: str, scalars: dict[str, str]) -> str:
    """Expand the $var / ${var} references makepkg resolves before .SRCINFO."""

    def sub(match: re.Match[str]) -> str:
        name = match.group(1) or match.group(2)
        if name not in scalars:
            raise CheckError(
                f"cannot expand ${{{name}}}: no plain assignment for it in the "
                "PKGBUILD, so the .SRCINFO comparison would be guesswork"
            )
        return scalars[name]

    return re.sub(r"\$\{(\w+)\}|\$(\w+)", sub, value)


def parse_pkgbuild(path: Path) -> tuple[dict[str, list[str]], dict[str, dict[str, list[str]]]]:
    """Return (pkgbase fields, {pkgname: overridden fields}).

    A deliberately small parser rather than `source`ing the file: this runs in
    CI over a file that produces a package, and sourcing it to read metadata is
    a needless execution of packaging code.
    """
    text = path.read_text()
    scalars: dict[str, str] = {}
    fields: dict[str, list[str]] = {}

    body_start = re.search(r"^\w[\w-]*\(\)\s*\{", text, re.MULTILINE)
    header = text[: body_start.start()] if body_start else text

    for name, raw in assignments(header):
        values = [expand(value, scalars) for value in raw]
        fields[name] = values
        if len(values) == 1:
            scalars.setdefault(name, values[0])

    if "pkgname" not in fields:
        raise CheckError(f"{path}: no pkgname assignment")

    splits: dict[str, dict[str, list[str]]] = {}
    for match in re.finditer(
        r"^package_([\w.+-]+)\(\)\s*\{\n(.*?)^\}$", text, re.DOTALL | re.MULTILINE
    ):
        name, body = match.group(1), match.group(2)
        scoped = dict(scalars)
        scoped["pkgname"] = name
        overrides: dict[str, list[str]] = {}
        for key, raw in assignments(body):
            if key not in SPLIT_KEYS:
                continue
            overrides[key] = [expand(value, scoped) for value in raw]
        splits[name] = overrides

    # For a non-split package, makepkg uses the pkgname stanza as pkgbase fields.
    if not splits and re.search(r"^package\(\)\s*\{", text, re.MULTILINE):
        only = scalars.get("pkgname")
        if only:
            splits[only] = {}

    return fields, splits


def array_end(text: str, start: int) -> int:
    """Index of the `)` closing the array opened at `start`, quotes respected.

    Element text routinely contains parentheses — "Firefox theming (AUR; pip
    elsewhere)" — so depth counting alone is not enough.
    """
    depth, quote, index = 0, "", start
    while index < len(text):
        char = text[index]
        if quote:
            if char == quote:
                quote = ""
        elif char in "'\"":
            quote = char
        elif char == "(":
            depth += 1
        elif char == ")":
            depth -= 1
            if depth == 0:
                return index
        index += 1
    raise CheckError("unterminated array assignment in PKGBUILD")


def scalar_end(text: str, start: int) -> int:
    """Return the index after a scalar value, including quotes and continuations.

    A quoted newline or a trailing backslash continues the value onto another line.
    """
    quote, index = "", start
    while index < len(text):
        char = text[index]
        if quote:
            if char == quote:
                quote = ""
        elif char in "'\"":
            quote = char
        elif char == "\\" and index + 1 < len(text):
            index += 1
        elif char == "\n":
            return index
        index += 1
    return len(text)


def assignments(text: str):
    """Yield (name, [values]) for the plain assignments in `text`."""
    index = 0
    pattern = re.compile(r"^[ \t]*([A-Za-z_]\w*)=", re.MULTILINE)
    while (match := pattern.search(text, index)) is not None:
        name, start = match.group(1), match.end()
        if text[start : start + 1] == "(":
            end = array_end(text, start)
            raw = text[start + 1 : end]
        else:
            end = scalar_end(text, start)
            raw = text[start:end]
        # Resume after the value, so an assignment spanning several lines
        # cannot have its continuation lines rescanned as further assignments.
        index = end + 1
        try:
            values = shlex.split(raw, comments=True)
        except ValueError as error:
            raise CheckError(
                f"cannot parse the assignment to {name}: {error}. The value "
                f"read as {raw!r}"
            ) from None
        yield name, values


def parse_srcinfo(path: Path) -> tuple[dict[str, list[str]], dict[str, dict[str, list[str]]]]:
    base: dict[str, list[str]] = {}
    splits: dict[str, dict[str, list[str]]] = {}
    current = base
    for number, line in enumerate(path.read_text().splitlines(), start=1):
        if not line.strip():
            continue
        if "=" not in line:
            raise CheckError(f"{path}:{number}: not a `key = value` line: {line!r}")
        key, _, value = line.partition("=")
        key, value = key.strip(), value.strip()
        if key == "pkgbase":
            continue
        if key == "pkgname" and not line.startswith(("\t", " ")):
            current = splits.setdefault(value, {})
            base.setdefault("pkgname", []).append(value)
            continue
        current.setdefault(key, []).append(value)
    return base, splits


def compare(label: str, expected: dict[str, list[str]], actual: dict[str, list[str]],
            keys) -> list[str]:
    problems = []
    for key in keys:
        want, have = expected.get(key), actual.get(key)
        if want is None and have is None:
            continue
        if want != have:
            problems.append(
                f"{label}: {key} differs\n"
                f"    PKGBUILD: {want if want is not None else '(absent)'}\n"
                f"    .SRCINFO: {have if have is not None else '(absent)'}"
            )
    return problems


def check_local(package: str, directory: Path) -> list[str]:
    pkgbuild, splits = parse_pkgbuild(directory / "PKGBUILD")
    base, srcsplits = parse_srcinfo(directory / ".SRCINFO")

    problems = compare(package, pkgbuild, base, ("pkgname",) + KEYS)

    if set(splits) != set(srcsplits):
        problems.append(
            f"{package}: package_* functions {sorted(splits)} but .SRCINFO has "
            f"stanzas {sorted(srcsplits)}"
        )
    for name in sorted(set(splits) & set(srcsplits)):
        problems.extend(
            compare(f"{package}/{name}", splits[name], srcsplits[name], SPLIT_KEYS)
        )

    for values in splits.values():
        for scriptlet in values.get("install", []):
            if not (directory / scriptlet).is_file():
                problems.append(
                    f"{package}: install={scriptlet} names no file in "
                    f"{directory.relative_to(ROOT)}"
                )
    return problems


def check_remote(package: str, directory: Path, files: tuple[str, ...]) -> list[str]:
    with tempfile.TemporaryDirectory() as tmp:
        clone = Path(tmp) / package
        result = subprocess.run(
            ["git", "clone", "--quiet", "--depth", "1", f"{AUR_REMOTE}/{package}.git", str(clone)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise CheckError(
                f"cannot clone {AUR_REMOTE}/{package}.git, so NOTHING about the "
                f"published package was checked: {result.stderr.strip()}"
            )
        # The AUR answers a name nobody has pushed with an empty repository,
        # not an error. Say so plainly instead of listing every file as absent.
        head = subprocess.run(
            ["git", "-C", str(clone), "rev-parse", "--verify", "--quiet", "HEAD"],
            capture_output=True,
            text=True,
        )
        if head.returncode != 0:
            return [
                f"{package}: not on the AUR yet (its repository is empty); the "
                "first scripts/publish-aur.sh push creates it"
            ]

        problems = []
        for name in files:
            published = clone / name
            if not published.is_file():
                problems.append(f"{package}: {name} is not published at all")
                continue
            want = (directory / name).read_text().splitlines(keepends=True)
            have = published.read_text().splitlines(keepends=True)
            if want == have:
                continue
            diff = "".join(
                difflib.unified_diff(
                    have, want, fromfile=f"aur/{package}/{name}",
                    tofile=f"{directory.relative_to(ROOT)}/{name}",
                )
            )
            problems.append(f"{package}: {name} on the AUR is not this repo's\n{diff}")
        return problems


def remote_sources(directory: Path) -> list[str]:
    """The http(s) URLs a package's sources are fetched from, expanded.

    `git+…` and local file sources are left out: they resolve regardless of
    whether a release exists, which is the question the caller is asking.
    """
    fields, _ = parse_pkgbuild(directory / "PKGBUILD")
    urls = []
    for key, values in fields.items():
        if key != "source" and not key.startswith("source_"):
            continue
        for value in values:
            # makepkg allows `filename::url`.
            url = value.split("::", 1)[-1]
            if url.startswith(("http://", "https://")):
                urls.append(url)
    return urls


def remote_source_checksums(directory: Path) -> list[tuple[str, str]]:
    """Pair each HTTP(S) source with its declared SHA-256 digest.

    makepkg pairs source and checksum arrays by index within each architecture
    suffix. Flattening the arrays first can pair a source with the wrong digest.
    """
    fields, _ = parse_pkgbuild(directory / "PKGBUILD")
    paired = []
    for key, values in fields.items():
        if key != "source" and not key.startswith("source_"):
            continue
        sums = fields.get("sha256sums" + key[len("source"):], [])
        for index, value in enumerate(values):
            url = value.split("::", 1)[-1]
            if not url.startswith(("http://", "https://")):
                continue
            if index >= len(sums):
                raise CheckError(
                    f"{directory.name}/PKGBUILD declares {key}[{index}] with no matching sha256sum"
                )
            paired.append((url, sums[index]))
    return paired


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--remote",
        action="store_true",
        help="also diff the published AUR repositories (requires network)",
    )
    parser.add_argument(
        "--print-sources",
        action="store_true",
        help="print the http(s) source URLs of the selected packages and exit",
    )
    parser.add_argument(
        "--print-source-checksums",
        action="store_true",
        help="print each http(s) source URL and the sha256 the recipe declares for it",
    )
    parser.add_argument(
        "packages",
        nargs="*",
        choices=[*PACKAGES, []],
        help="packages to check (default: all of them)",
    )
    args = parser.parse_args()
    selected = {name: PACKAGES[name] for name in (args.packages or PACKAGES)}

    if args.print_source_checksums:
        try:
            for _, (relative, _) in selected.items():
                for url, digest in remote_source_checksums(ROOT / relative):
                    print(f"{url}\t{digest}")
        except CheckError as error:
            print(f"check-aur-sync: {error}", file=sys.stderr)
            return 2
        return 0

    if args.print_sources:
        try:
            for _, (relative, _) in selected.items():
                for url in remote_sources(ROOT / relative):
                    print(url)
        except CheckError as error:
            print(f"check-aur-sync: {error}", file=sys.stderr)
            return 2
        return 0

    problems: list[str] = []
    try:
        for package, (relative, files) in selected.items():
            directory = ROOT / relative
            for name in files:
                if not (directory / name).is_file():
                    raise CheckError(f"{relative}/{name} is missing")
            problems.extend(check_local(package, directory))
            if args.remote:
                problems.extend(check_remote(package, directory, files))
    except CheckError as error:
        print(f"check-aur-sync: {error}", file=sys.stderr)
        return 2

    if problems:
        print("check-aur-sync: the Arch recipes have drifted:", file=sys.stderr)
        for problem in problems:
            print(f"  {problem}", file=sys.stderr)
        if args.remote:
            print(
                "\nPublish the repo recipes with scripts/publish-aur.sh; the AUR "
                "repository is never the source of truth.",
                file=sys.stderr,
            )
        else:
            print(
                "\nRegenerate the .SRCINFO in the recipe directory with "
                "`makepkg --printsrcinfo > .SRCINFO`.",
                file=sys.stderr,
            )
        return 1

    packages = ", ".join(selected)
    if args.remote:
        print(f"AUR recipes match this repo ({packages})")
    else:
        print(f"Arch PKGBUILD/.SRCINFO agree ({packages})")
        print(
            "NOT CHECKED: what aur.archlinux.org actually publishes. That needs "
            "network; run scripts/check-aur-sync.py --remote."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
