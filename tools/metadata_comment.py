"""Format arbitrary metadata as a Base64 comment block for source files.

The block returned by :func:`embed_metadata_comment` is plain text written in
the comment syntax of the target language, so it can be pasted into a source
file and recovered later by stripping the comment markers and running the
payload through :func:`base64.b64decode`.
:func:`extract_metadata_from_comment` does that recovery, reading a file back
and returning the original string.
"""

from __future__ import annotations

import base64
import binascii
from typing import NamedTuple

__all__ = [
    "FOOTER",
    "HEADER",
    "LINE_WIDTH",
    "SUPPORTED_LANGUAGES",
    "MetadataError",
    "MetadataDecodeError",
    "MetadataNotFoundError",
    "embed_metadata_comment",
    "extract_metadata_from_comment",
]

HEADER = "Encoded metadata (Base64) – decode with base64.b64decode"

#: Leading part of :data:`HEADER` used to recognise a block on the way back in.
#: Stopping before the dash keeps extraction working across the hyphen and
#: en dash spellings that editors and copy-paste tend to swap.
HEADER_MARKER = "Encoded metadata (Base64)"

#: Line that closes a block, so extraction has an explicit end rather than a
#: guess. The old reader stopped at the first payload line that was short or
#: carried ``=`` padding, on the assumption that only the last line ever is.
#: That assumption breaks whenever the payload is an exact multiple of
#: :data:`LINE_WIDTH` (a UTF-8 length that is a multiple of 57 bytes): every
#: line is then full width and unpadded, so nothing marks the end and the
#: reader keeps consuming Base64-looking comment lines that follow the block,
#: silently returning more bytes than were embedded. A footer removes the guess.
FOOTER = "End encoded metadata (Base64)"

#: Leading part of :data:`FOOTER`, matched the same forgiving way as
#: :data:`HEADER_MARKER`. Its wording never begins with :data:`HEADER_MARKER`,
#: so the header scan can never mistake a footer for the start of a block.
FOOTER_MARKER = "End encoded metadata (Base64)"

#: Width of a payload line, matching the MIME convention of 76 characters.
LINE_WIDTH = 76

_BASE64_ALPHABET = frozenset(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/="
)


class MetadataError(Exception):
    """Base class for failures while recovering an embedded metadata block."""


class MetadataNotFoundError(MetadataError):
    """Raised when a file holds no recognisable metadata header."""


class MetadataDecodeError(MetadataError):
    """Raised when a block is found but its payload will not decode."""


class _CommentStyle(NamedTuple):
    """How one language opens, prefixes and closes a multi-line comment."""

    prefix: str = ""
    opener: str = ""
    closer: str = ""


_HASH = _CommentStyle(prefix="# ")
_SLASHES = _CommentStyle(prefix="// ")
_DASHES = _CommentStyle(prefix="-- ")
_SEMICOLON = _CommentStyle(prefix="; ")
_C_BLOCK = _CommentStyle(prefix=" * ", opener="/*", closer=" */")
_XML = _CommentStyle(opener="<!--", closer="-->")

_STYLES: dict[str, _CommentStyle] = {
    "bash": _HASH,
    "c": _SLASHES,
    "clojure": _SEMICOLON,
    "cpp": _SLASHES,
    "csharp": _SLASHES,
    "css": _C_BLOCK,
    "go": _SLASHES,
    "haskell": _DASHES,
    "html": _XML,
    "ini": _SEMICOLON,
    "java": _SLASHES,
    "javascript": _SLASHES,
    "kotlin": _SLASHES,
    "lisp": _SEMICOLON,
    "lua": _DASHES,
    "markdown": _XML,
    "perl": _HASH,
    "php": _SLASHES,
    "python": _HASH,
    "r": _HASH,
    "ruby": _HASH,
    "rust": _SLASHES,
    "shell": _HASH,
    "sql": _DASHES,
    "swift": _SLASHES,
    "toml": _HASH,
    "typescript": _SLASHES,
    "xml": _XML,
    "yaml": _HASH,
}

_ALIASES = {
    "c#": "csharp",
    "c++": "cpp",
    "js": "javascript",
    "py": "python",
    "sh": "shell",
    "ts": "typescript",
    "yml": "yaml",
    "zsh": "shell",
}

#: Every language name accepted by :func:`embed_metadata_comment`.
SUPPORTED_LANGUAGES = tuple(sorted({*_STYLES, *_ALIASES}))


def _resolve_style(language: str) -> _CommentStyle:
    """Return the comment style for ``language``, or raise :class:`ValueError`."""
    key = language.strip().lower()
    style = _STYLES.get(_ALIASES.get(key, key))
    if style is None:
        raise ValueError(
            f"Unsupported language {language!r}; expected one of: "
            + ", ".join(SUPPORTED_LANGUAGES)
        )
    return style


def _uncomment(line: str, style: _CommentStyle) -> str | None:
    """Strip ``style``'s comment marker off ``line``.

    Returns the remaining text, or ``None`` when the line does not carry the
    marker at all. Block styles have no per-line marker, so every line of one
    is treated as content.
    """
    text = line.strip()
    marker = style.prefix.strip()
    if marker:
        if not text.startswith(marker):
            return None
        text = text[len(marker) :]
    return text.strip()


def embed_metadata_comment(metadata: str, language: str = "python") -> str:
    """Return ``metadata`` as a Base64 comment block for ``language``.

    The block is a header line, the Base64 payload wrapped at
    :data:`LINE_WIDTH` characters, and a footer line, commented out with the
    syntax of the target language. The footer is what lets
    :func:`extract_metadata_from_comment` find the end of the payload without
    guessing. It carries no trailing newline, so the caller decides how it
    joins the surrounding source.

    Args:
        metadata: The text to embed. Encoded as UTF-8 before Base64.
        language: A name or alias from :data:`SUPPORTED_LANGUAGES`, matched
            case-insensitively.

    Returns:
        The formatted comment block. Empty ``metadata`` yields the header and
        footer with no payload between them.

    Raises:
        ValueError: If ``language`` is not one of :data:`SUPPORTED_LANGUAGES`.

    Examples:
        >>> print(embed_metadata_comment("build=42"))
        # Encoded metadata (Base64) – decode with base64.b64decode
        # YnVpbGQ9NDI=
        # End encoded metadata (Base64)

        >>> print(embed_metadata_comment("build=42", "html"))
        <!--
        Encoded metadata (Base64) – decode with base64.b64decode
        YnVpbGQ9NDI=
        End encoded metadata (Base64)
        -->
    """
    style = _resolve_style(language)
    payload = base64.b64encode(metadata.encode("utf-8")).decode("ascii")
    chunks = [
        payload[start : start + LINE_WIDTH]
        for start in range(0, len(payload), LINE_WIDTH)
    ]

    lines: list[str] = []
    if style.opener:
        lines.append(style.opener)
    lines.append(f"{style.prefix}{HEADER}".rstrip())
    lines.extend(f"{style.prefix}{chunk}" for chunk in chunks)
    lines.append(f"{style.prefix}{FOOTER}".rstrip())
    if style.closer:
        lines.append(style.closer)
    return "\n".join(lines)


def extract_metadata_from_comment(file_path: str, language: str = "python") -> str:
    """Return the metadata embedded in ``file_path`` by :func:`embed_metadata_comment`.

    The file is scanned for a header line in ``language``'s comment syntax, and
    the Base64 payload directly beneath it is collected up to the footer that
    :func:`embed_metadata_comment` writes, then decoded. A block written by an
    older version that has no footer still reads: collection then also stops at
    the first line that is short, padded, or not Base64 at all, which is where
    such a block ends in every case except a payload that is an exact multiple
    of :data:`LINE_WIDTH`. So ordinary comments and code after the block are
    never swallowed. If a file holds more than one block, the first one
    carrying a payload is returned, which lets a file quote the header in prose
    without shadowing its real block.

    Args:
        file_path: Path to the file to scan. Read as UTF-8, with undecodable
            bytes replaced rather than raised, since a Base64 payload is always
            ASCII and the rest of the file only has to be searchable.
        language: A name or alias from :data:`SUPPORTED_LANGUAGES`, matched
            case-insensitively. It must match the language the block was
            written with, since it selects the comment syntax to strip.

    Returns:
        The decoded metadata. A file whose only headers carry no payload
        returns the empty string, mirroring what :func:`embed_metadata_comment`
        writes for empty metadata.

    Raises:
        ValueError: If ``language`` is not one of :data:`SUPPORTED_LANGUAGES`.
        MetadataNotFoundError: If no header for ``language`` is found.
        MetadataDecodeError: If the payload is not valid Base64, or does not
            decode to UTF-8 text.
        OSError: If the file cannot be read. :class:`FileNotFoundError` and
            :class:`PermissionError` are the usual cases, and both propagate
            unchanged so callers can tell them apart.
    """
    style = _resolve_style(language)

    with open(file_path, encoding="utf-8", errors="replace") as handle:
        lines = handle.read().splitlines()

    saw_header = False
    for index, line in enumerate(lines):
        content = _uncomment(line, style)
        if content is None or not content.startswith(HEADER_MARKER):
            continue
        saw_header = True

        chunks: list[str] = []
        closer = style.closer.strip()
        for payload_line in lines[index + 1 :]:
            if closer and payload_line.strip() == closer:
                break
            chunk = _uncomment(payload_line, style)
            # The footer ends the block outright, which is the whole point of
            # writing one: the payload above it may be any length, exact
            # multiple of LINE_WIDTH included, and still stop here.
            if chunk is not None and chunk.startswith(FOOTER_MARKER):
                break
            if not chunk or not _BASE64_ALPHABET.issuperset(chunk):
                break
            chunks.append(chunk)
            # Footerless legacy fallback: the closing chunk is short or padded,
            # and anything after it belongs to the file, not to the block. A
            # footer, when present, has already ended the loop above.
            if len(chunk) < LINE_WIDTH or "=" in chunk:
                break

        if not chunks:
            # A header with nothing usable under it: either a block for empty
            # metadata, or prose quoting the header. Neither is worth failing
            # over while a real block may still be further down the file.
            continue

        try:
            return base64.b64decode("".join(chunks), validate=True).decode("utf-8")
        except (binascii.Error, UnicodeDecodeError) as error:
            raise MetadataDecodeError(
                f"Found a metadata block at line {index + 1} of {file_path!r}, "
                f"but its payload could not be decoded: {error}"
            ) from error

    if saw_header:
        return ""

    raise MetadataNotFoundError(
        f"No {language} metadata block found in {file_path!r}; "
        f"expected a comment line starting with {HEADER_MARKER!r}."
    )
