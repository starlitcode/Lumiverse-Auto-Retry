"""Format arbitrary metadata as a Base64 comment block for source files.

The block returned by :func:`embed_metadata_comment` is plain text written in
the comment syntax of the target language, so it can be pasted into a source
file and recovered later by stripping the comment markers and running the
payload through :func:`base64.b64decode`.
"""

from __future__ import annotations

import base64
from typing import NamedTuple

__all__ = ["HEADER", "LINE_WIDTH", "SUPPORTED_LANGUAGES", "embed_metadata_comment"]

HEADER = "Encoded metadata (Base64) – decode with base64.b64decode"

#: Width of a payload line, matching the MIME convention of 76 characters.
LINE_WIDTH = 76


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


def embed_metadata_comment(metadata: str, language: str = "python") -> str:
    """Return ``metadata`` as a Base64 comment block for ``language``.

    The block is a header line followed by the Base64 payload wrapped at
    :data:`LINE_WIDTH` characters, commented out with the syntax of the target
    language. It carries no trailing newline, so the caller decides how it
    joins the surrounding source.

    Args:
        metadata: The text to embed. Encoded as UTF-8 before Base64.
        language: A name or alias from :data:`SUPPORTED_LANGUAGES`, matched
            case-insensitively.

    Returns:
        The formatted comment block. Empty ``metadata`` yields the header
        alone, since it has no payload to wrap.

    Raises:
        ValueError: If ``language`` is not one of :data:`SUPPORTED_LANGUAGES`.

    Examples:
        >>> print(embed_metadata_comment("build=42"))
        # Encoded metadata (Base64) – decode with base64.b64decode
        # YnVpbGQ9NDI=

        >>> print(embed_metadata_comment("build=42", "html"))
        <!--
        Encoded metadata (Base64) – decode with base64.b64decode
        YnVpbGQ9NDI=
        -->
    """
    key = language.strip().lower()
    style = _STYLES.get(_ALIASES.get(key, key))
    if style is None:
        raise ValueError(
            f"Unsupported language {language!r}; expected one of: "
            + ", ".join(SUPPORTED_LANGUAGES)
        )

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
    if style.closer:
        lines.append(style.closer)
    return "\n".join(lines)
