"""Deterministic native-text PDF extraction cached by content hash.

Input:  {"path": str, "sha256": str (expected, lowercase hex)}
Output: {"sha256", "pageCount", "extractorVersion", "cached", "pages": [{page, text, charCount, extractable}]}

The sha256 of the file bytes is verified BEFORE extraction; a mismatch is an error
(the caller cited a different document version). Pages are 1-based physical PDF
page indexes (not printed folio numbers). Cache file:
``<cacheDir>/<sha256>.<extractorVersion>.json`` (default cacheDir
``data/raw/extract-cache`` under the repository root). A cache hit is only used if its
recorded sha256 and extractorVersion match; otherwise it is regenerated.
No OCR is performed: a page with fewer than MIN_CHARS non-whitespace characters is
reported ``extractable: false`` so scans are visible instead of silently empty.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path
from typing import Any

import pypdf

# Bump when extraction behaviour changes (pypdf version is part of the identity).
EXTRACTOR_VERSION = f"pypdf-native-text-1+pypdf{pypdf.__version__}"
MIN_CHARS = 20
_HEX = re.compile(r"^[0-9a-f]{64}$")


class ExtractionError(ValueError):
    pass


def repo_root() -> Path:
    # analytics/harvest_analytics/extract/pdf_text.py -> repo root
    return Path(__file__).resolve().parents[3]


def default_cache_dir() -> Path:
    return repo_root() / "data" / "raw" / "extract-cache"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _cache_path(cache_dir: Path, sha: str) -> Path:
    safe_version = re.sub(r"[^A-Za-z0-9._+-]", "_", EXTRACTOR_VERSION)
    return cache_dir / f"{sha}.{safe_version}.json"


def extract_pdf_text(path: str | os.PathLike[str], sha256: str, cache_dir: str | os.PathLike[str] | None = None) -> dict[str, Any]:
    if not isinstance(sha256, str) or not _HEX.match(sha256):
        raise ExtractionError("sha256 must be 64 lowercase hex characters")
    p = Path(path)
    if not p.is_absolute():
        p = repo_root() / p
    if not p.is_file():
        raise ExtractionError(f"file not found: {path}")
    actual = sha256_file(p)
    if actual != sha256:
        raise ExtractionError(f"sha256 mismatch: expected {sha256}, actual {actual}")

    cdir = Path(cache_dir) if cache_dir is not None else default_cache_dir()
    cpath = _cache_path(cdir, actual)
    if cpath.is_file():
        try:
            cached = json.loads(cpath.read_text(encoding="utf-8"))
            if cached.get("sha256") == actual and cached.get("extractorVersion") == EXTRACTOR_VERSION:
                cached["cached"] = True
                return cached
        except ValueError:
            pass  # corrupt cache: regenerate

    reader = pypdf.PdfReader(str(p))
    pages = []
    for i, pg in enumerate(reader.pages, start=1):
        text = pg.extract_text() or ""
        pages.append(
            {
                "page": i,
                "text": text,
                "charCount": len(text),
                "extractable": len(re.sub(r"\s", "", text)) >= MIN_CHARS,
            }
        )
    result = {
        "sha256": actual,
        "pageCount": len(pages),
        "extractorVersion": EXTRACTOR_VERSION,
        "pages": pages,
    }
    cdir.mkdir(parents=True, exist_ok=True)
    tmp = cpath.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    tmp.replace(cpath)
    return {**result, "cached": False}


def allowed_roots() -> list[Path]:
    """Directories the CLI entrypoint may read PDFs from (library calls are unrestricted)."""
    return [repo_root() / "data" / "raw"]


def pdf_text_entrypoint(payload: dict[str, Any]) -> dict[str, Any]:
    """CLI registry entrypoint ``extract.pdf_text``: {path, sha256} -> page texts.

    The path must resolve inside an allowed root (data/raw/); the cache directory is
    fixed (not caller-controlled).
    """
    path = payload.get("path")
    sha = payload.get("sha256")
    if not isinstance(path, str) or not path:
        raise ExtractionError("path is required")
    p = Path(path)
    if not p.is_absolute():
        p = repo_root() / p
    resolved = p.resolve()
    if not any(resolved.is_relative_to(r.resolve()) for r in allowed_roots()):
        raise ExtractionError("path is outside the allowed source directory")
    return extract_pdf_text(resolved, sha)
