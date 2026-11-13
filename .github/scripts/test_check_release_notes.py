import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from pathlib import Path

import check_release_notes

SOURCE = "Source: [Pull request #34](https://github.com/toxdes/vylk/pull/34)"
RELEASES = f"""\
# Releases

Release descriptions are copied verbatim from their linked sources.

<!-- prettier-ignore-start -->

## v3.1.2

Merged: 2026-10-31
{SOURCE}

## Changes
1. fix(ui): keep view/save controls on the preview pane

## v3.1.1

Merged: 2026-10-20
Source: [Pull request #28](https://github.com/toxdes/vylk/pull/28)

## Changes
1. feat(zen): inline formatting and links

<!-- prettier-ignore-end -->
"""


def entry(
    version="v3.1.3",
    metadata=f"Merged: 2026-11-13\n{SOURCE}",
    body="## Changes\n1. fix",
):
    return f"## {version}\n\n{metadata}\n\n{body}\n"


class ReleaseNotesTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.write(RELEASES, "3.1.2")

    def write(self, releases, version):
        (self.root / "releases.md").write_text(releases)
        (self.root / "VERSION").write_text(f"{version}\n")

    def run_main(self):
        stdout, stderr = StringIO(), StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            code = check_release_notes.main(
                {
                    "VERSION_PATH": str(self.root / "VERSION"),
                    "RELEASES_PATH": str(self.root / "releases.md"),
                }
            )
        return code, stdout.getvalue(), stderr.getvalue()

    def test_current_version_with_section_passes(self):
        code, stdout, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("contains the v3.1.2 section", stdout)

    def test_bumped_version_without_section_fails(self):
        self.write(RELEASES, "3.1.3")
        code, _, stderr = self.run_main()
        self.assertEqual(code, 1)
        self.assertIn("releases.md has no section for v3.1.3", stderr)
        self.assertIn("## v3.1.3", stderr)

    def test_unrelated_pull_request_passes_because_main_is_in_sync(self):
        self.write(RELEASES, "3.1.2")
        code, _, stderr = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(stderr, "")

    def test_nightly_version_is_skipped(self):
        self.write(RELEASES, "nightly-20260101-gabc1234")
        code, stdout, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertIn("not a stable", stdout)

    def test_entry_requires_date_source_and_body(self):
        invalid = (
            "Merged: 2026-11-13",
            SOURCE,
            f"Merged: 2026-11-13\n{SOURCE}",
        )
        for metadata in invalid:
            with self.subTest(metadata=metadata):
                document = entry(metadata=metadata, body="")
                with self.assertRaises(check_release_notes.ReleaseNotesError):
                    check_release_notes.parse_releases(document)

    def test_valid_entry_parses(self):
        entries = check_release_notes.parse_releases(entry())
        self.assertEqual(entries["v3.1.3"].date_label, "Merged")
        self.assertEqual(
            entries["v3.1.3"].source_url, "https://github.com/toxdes/vylk/pull/34"
        )

    def test_duplicate_version_is_rejected(self):
        with self.assertRaisesRegex(
            check_release_notes.ReleaseNotesError, "invalid or duplicate"
        ):
            check_release_notes.parse_releases(RELEASES + RELEASES)

    def test_invalid_date_is_rejected(self):
        broken = RELEASES.replace("Merged: 2026-10-31", "Merged: 2026-13-45")
        with self.assertRaisesRegex(
            check_release_notes.ReleaseNotesError, "invalid date"
        ):
            check_release_notes.parse_releases(broken)


class RepositoryReleasesTests(unittest.TestCase):
    def test_repository_releases_cover_the_version(self):
        root = Path(check_release_notes.__file__).resolve().parents[2]
        tag = check_release_notes.stable_version((root / "VERSION").read_text())
        self.assertIsNotNone(tag)
        entries = check_release_notes.parse_releases((root / "releases.md").read_text())
        self.assertIn(tag, entries)
