"""The refusal the check scripts raise and print.

A refusal prints a stable `key=value` line naming the value acted on, which
the scripts' tests match whole, then a GitHub Actions error annotation
carrying the prose for a person.
"""

from __future__ import annotations

import sys
from typing import NoReturn


class Refusal(Exception):
    def __init__(self, line: str, prose: str) -> None:
        super().__init__(line, prose)
        self.line = line
        self.prose = prose


def refuse(line: str, prose: str = "") -> NoReturn:
    raise Refusal(line, prose)


def report(error: Refusal, context: str) -> None:
    print(error.line, file=sys.stderr)
    print(f"::error::{context}: {error.prose or error.line}", file=sys.stderr)
