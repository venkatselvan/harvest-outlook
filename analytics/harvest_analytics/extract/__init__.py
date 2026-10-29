"""Source-grounded agronomy evidence pipeline (T05b).

- ``pdf_text``: deterministic native-text PDF extraction, cached by content hash.
- ``verify``: normalized-substring excerpt verification against cited pages.
"""

from .pdf_text import EXTRACTOR_VERSION, extract_pdf_text, pdf_text_entrypoint
from .verify import normalize_text, excerpt_on_page

__all__ = ["EXTRACTOR_VERSION", "extract_pdf_text", "pdf_text_entrypoint", "normalize_text", "excerpt_on_page"]
