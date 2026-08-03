"""Run a Python snippet that was bundled into a file as a Base64 comment.

This is the execution half of the code-packaging experiment: a snippet is
embedded with :func:`metadata_comment.embed_metadata_comment`, shipped inside
some other file, and later pulled back out and run here.

Security note — read before pointing this at anything
-----------------------------------------------------
:func:`run_embedded_code` decodes the block and hands it straight to
:func:`exec`, so it runs with the full privileges of the calling process:
whatever the snippet says to do, it does. That is the point of the feature,
and also its only real hazard. Treat the *file* exactly as you would treat a
Python script someone asked you to run — only run files you produced or fully
trust, since a swapped or edited block is arbitrary code execution. There is
no sandbox here and none is implied.
"""

from __future__ import annotations

from typing import Any

from metadata_comment import extract_metadata_from_comment

__all__ = ["run_embedded_code"]


def run_embedded_code(
    file_path: str,
    *,
    run_as_main: bool = False,
    namespace: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Extract the Base64 Python block from ``file_path`` and execute it.

    The block is located and decoded by
    :func:`metadata_comment.extract_metadata_from_comment` (Python comment
    syntax), compiled with the file's path as its name so tracebacks point at
    something real, and run with :func:`exec`.

    Args:
        file_path: File containing the embedded snippet.
        run_as_main: If true, the snippet sees ``__name__ == "__main__"`` and
            so its ``if __name__ == "__main__":`` block runs, as if it had been
            launched directly. Defaults to false, which runs it as an imported
            module would.
        namespace: Globals to execute in. A fresh dict is used when omitted.
            Passing one in lets the caller seed inputs and read results back
            out; it is mutated in place and then returned.

    Returns:
        The globals dict the snippet ran in, so callers can pull out any names
        it defined.

    Raises:
        MetadataNotFoundError: If ``file_path`` holds no Python metadata block.
        MetadataDecodeError: If the block is present but will not decode.
        OSError: If the file cannot be read.
        SyntaxError: If the decoded text is not valid Python.
        Exception: Anything the snippet itself raises propagates unchanged.
    """
    source = extract_metadata_from_comment(file_path, "python")

    if namespace is None:
        namespace = {}
    namespace.setdefault("__file__", file_path)
    namespace["__name__"] = "__main__" if run_as_main else "__embedded__"

    code = compile(source, f"<embedded:{file_path}>", "exec")
    exec(code, namespace)  # noqa: S102 - executing bundled code is the feature
    return namespace
