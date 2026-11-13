#!/usr/bin/env python3
"""Require a releases.md section for the version in VERSION.

A pull request that bumps VERSION is a release pull request, and the lander
build reads releases.md from main. Without the matching section the release
merges and ships a stale banner. Every other pull request already passes
because main keeps VERSION and releases.md in sync.

The parser below matches the lander's parser in
vylk-lander/scripts/announcements.py; keep them aligned.
"""

from __future__ import annotations

import os
import re
import sys
from dataclasses import dataclass
from datetime import date
from pathlib import Path

VERSION = r"v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)"
STABLE_VERSION = re.compile(rf"^{VERSION}$")
RELEASE_HEADING = re.compile(rf"^## ({VERSION})$", re.MULTILINE)
ENTRY = re.compile(
    r"(Merged|Published): (\d{4}-\d{2}-\d{2})\n"
    r"Source: \[([^\]]+)\]\((https://github\.com/toxdes/vylk/[^\s)]+)\)\n\n"
    r"(.+)",
    re.DOTALL,
)
MISSING_ENTRY = """\
releases.md has no section for {tag}. Add one before merging, using only the
bullet list from the release pull request description:

## {tag}

Merged: YYYY-MM-DD
Source: [Pull request #N](https://github.com/toxdes/vylk/pull/N)

1. first change
2. second change"""


class ReleaseNotesError(ValueError):
    """Raised when releases.md cannot be parsed or lacks the release."""


@dataclass(frozen=True)
class ReleaseEntry:
    tag: str
    date_label: str
    published: date
    source_label: str
    source_url: str
    description: str


def parse_releases(markdown: str) -> dict[str, ReleaseEntry]:
    markdown = markdown.removesuffix("\n<!-- prettier-ignore-end -->\n")
    headings = list(RELEASE_HEADING.finditer(markdown))
    entries = {}
    for index, heading in enumerate(headings):
        tag = heading[1]
        end = (
            headings[index + 1].start() if index + 1 < len(headings) else len(markdown)
        )
        entry = markdown[heading.end() : end].strip()
        metadata = ENTRY.fullmatch(entry)
        if tag in entries or not metadata:
            raise ReleaseNotesError(
                f"releases.md has an invalid or duplicate entry for {tag}"
            )
        label, day, source_label, source_url, description = metadata.groups()
        try:
            published = date.fromisoformat(day)
        except ValueError as error:
            raise ReleaseNotesError(
                f"releases.md entry for {tag} has an invalid date: {day}"
            ) from error
        entries[tag] = ReleaseEntry(
            tag, label, published, source_label, source_url, description
        )
    return entries


def stable_version(text: str) -> str | None:
    version = text.strip()
    tag = f"v{version}"
    return tag if STABLE_VERSION.fullmatch(tag) else None


def check_release_notes(markdown: str, tag: str) -> None:
    entries = parse_releases(markdown)
    if tag not in entries:
        raise ReleaseNotesError(MISSING_ENTRY.format(tag=tag))


def main(environment: dict[str, str] | None = None) -> int:
    values = os.environ if environment is None else environment
    version_path = Path(values.get("VERSION_PATH", "VERSION"))
    releases_path = Path(values.get("RELEASES_PATH", "releases.md"))
    try:
        tag = stable_version(version_path.read_text())
        if tag is None:
            print(f"{version_path} is not a stable vX.Y.Z version; skipped the check.")
            return 0
        check_release_notes(releases_path.read_text(), tag)
    except (OSError, ReleaseNotesError) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1
    print(f"releases.md contains the {tag} section.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
