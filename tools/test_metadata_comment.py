"""Tests for the Base64 metadata comment tooling.

The guarantee worth holding down here is round-tripping: whatever went into a
block comes back out byte for byte, and nothing that follows the block in the
file is ever mistaken for payload. The case that motivates the whole footer is
a payload whose length is an exact multiple of the line width, where the old
"stop at the first short or padded line" rule had nothing to stop on and read
straight into the rest of the file.

No test framework: run it with ``python3 tools/test_metadata_comment.py`` (or
point pytest at it). It exits non-zero on the first failure.
"""

from __future__ import annotations

import base64
import os
import tempfile

from metadata_comment import (
    FOOTER_MARKER,
    LINE_WIDTH,
    MetadataDecodeError,
    MetadataNotFoundError,
    embed_metadata_comment,
    extract_metadata_from_comment,
)
from run_embedded import run_embedded_code

# Line-comment languages are where the bug lived: a block-comment language ends
# its block with a closer, so it was never exposed to the guess in the first
# place. Both kinds are covered so the fix is confirmed not to regress either.
LANGUAGES = ("python", "javascript", "typescript", "sql", "yaml", "css", "html")

# A follower whose first line is itself valid Base64, which is what turned the
# old bug from a decode error into silent corruption: those bytes decoded.
BASE64_LOOKING_FOLLOWER = "# acaa\n# more file content\nprint(1)\n"


def _write(text: str) -> str:
    fd, path = tempfile.mkstemp(suffix=".txt")
    os.close(fd)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write(text)
    return path


def _roundtrip(metadata: str, language: str, tail: str = "") -> str:
    path = _write(embed_metadata_comment(metadata, language) + "\n" + tail)
    try:
        return extract_metadata_from_comment(path, language)
    finally:
        os.remove(path)


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


# An exact-multiple payload followed by a Base64-looking line is the regression:
# before the footer this returned more bytes than were embedded, without error.
def test_exact_multiple_payload_does_not_swallow_the_next_line() -> None:
    for units in (1, 2, 3):
        metadata = "A" * (57 * units)  # 57 UTF-8 bytes -> exactly 76 Base64 chars
        encoded = base64.b64encode(metadata.encode()).decode()
        check(len(encoded) % LINE_WIDTH == 0, "test setup: payload is not exact-multiple")
        got = _roundtrip(metadata, "python", BASE64_LOOKING_FOLLOWER)
        check(got == metadata, f"exact-multiple round-trip corrupted at {57 * units} bytes: {got!r}")


# The everyday case, across both comment shapes and a spread of lengths that
# straddle the line-width boundary in each direction.
def test_round_trip_holds_across_languages_and_lengths() -> None:
    for language in LANGUAGES:
        for length in (0, 1, 40, 57, 76, 114, 200):
            metadata = "A" * length
            got = _roundtrip(metadata, language, "trailing file content\n")
            check(got == metadata, f"{language} round-trip failed at {length} bytes: {got!r}")


# The payload is UTF-8 before Base64, so non-ASCII and multi-byte text must
# survive a trip through the block unchanged.
def test_unicode_and_multiline_survive() -> None:
    for metadata in ("café – naïve – 日本語 – 🎲", "line1\nline2\n\nline4", "   padded   "):
        got = _roundtrip(metadata, "python", "# after\nx = 1\n")
        check(got == metadata, f"unicode/multiline round-trip failed: {got!r}")


# A block written by an older version carries no footer. It must still read, so
# the fix cannot strand metadata already embedded in real files.
def test_footerless_legacy_block_still_reads() -> None:
    payload = base64.b64encode(("A" * 40).encode()).decode()  # short last line ends it
    legacy = (
        "# Encoded metadata (Base64) – decode with base64.b64decode\n"
        f"# {payload}\n"
        "# an ordinary comment after the block\n"
        "value = 1\n"
    )
    path = _write(legacy)
    try:
        check(extract_metadata_from_comment(path, "python") == "A" * 40, "legacy block did not read")
    finally:
        os.remove(path)


# Empty metadata is a header and footer with nothing between, and comes back as
# the empty string rather than raising.
def test_empty_metadata_round_trips_to_empty_string() -> None:
    block = embed_metadata_comment("", "python")
    check(FOOTER_MARKER in block, "empty block is missing its footer")
    check(_roundtrip("", "python", "x = 1\n") == "", "empty metadata did not round-trip")


# A file that only quotes the header in prose has no real block; that is a
# not-found, not a decode error, so a caller can tell the two apart.
def test_missing_block_raises_not_found() -> None:
    path = _write("just some text\nno metadata here\n")
    try:
        raised = False
        try:
            extract_metadata_from_comment(path, "python")
        except MetadataNotFoundError:
            raised = True
        check(raised, "a file with no block should raise MetadataNotFoundError")
    finally:
        os.remove(path)


# A block whose payload is valid Base64 but not UTF-8 text must fail loudly, so
# a corrupted file is never mistaken for valid metadata. (A payload that is not
# Base64 at all is treated as the block ending, not as a decode error.)
def test_malformed_payload_raises_decode_error() -> None:
    not_utf8 = base64.b64encode(b"\xff\xfe").decode()
    path = _write(
        "# Encoded metadata (Base64) – decode with base64.b64decode\n"
        f"# {not_utf8}\n"
        "# End encoded metadata (Base64)\n"
    )
    try:
        raised = False
        try:
            extract_metadata_from_comment(path, "python")
        except MetadataDecodeError:
            raised = True
        check(raised, "an undecodable payload should raise MetadataDecodeError")
    finally:
        os.remove(path)


# The execution half: a snippet whose source is an exact-multiple length must
# come back out whole and run, and the file tail after it must not leak in.
def test_run_embedded_executes_exact_multiple_snippet() -> None:
    snippet = "result = 6 * 7  # " + "x" * 39  # 57 bytes
    check(len(snippet.encode()) % 57 == 0, "test setup: snippet is not exact-multiple")
    path = _write(
        embed_metadata_comment(snippet, "python")
        + "\n# trailing note\nresult = 'tail leaked in'\n"
    )
    try:
        namespace = run_embedded_code(path)
        check(namespace.get("result") == 42, f"embedded snippet ran wrong: {namespace.get('result')!r}")
    finally:
        os.remove(path)


def main() -> int:
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_")]
    failed = 0
    for test in tests:
        try:
            test()
            print(f"ok   {test.__name__}")
        except AssertionError as error:
            failed += 1
            print(f"FAIL {test.__name__}: {error}")
    print(f"\n{len(tests) - failed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
