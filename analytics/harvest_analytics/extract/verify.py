"""Excerpt grounding check: normalized substring match on the cited page.

Normalisation (documented, deterministic): Unicode NFKC; common ligatures and
typographic quotes/dashes folded; soft hyphens removed; whitespace on either
side of a hyphen removed (pypdf renders "1300-1500" as "1300 -1500" and splits
"inter-\nspace" across lines); all other whitespace collapsed to single spaces;
case-folded. Nothing else (no fuzzy matching, no intra-word space repair: an
extraction artifact such as "pla nting" must be quoted as extracted).
An excerpt passes only if it is a substring of its own cited page after
normalisation.
"""

from __future__ import annotations

import re
import unicodedata

_FOLD = {
    "\u2018": "'", "\u2019": "'", "\u201c": '"', "\u201d": '"',
    "\u2013": "-", "\u2014": "-", "\u2212": "-", "\u00ad": "",
    "\ufb01": "fi", "\ufb02": "fl", "\u00a0": " ",
}


def normalize_text(s: str) -> str:
    s = unicodedata.normalize("NFKC", s)
    for k, v in _FOLD.items():
        s = s.replace(k, v)
    s = re.sub(r"\s*-\s*", "-", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip().casefold()


def excerpt_on_page(excerpt: str, page_text: str) -> bool:
    e = normalize_text(excerpt)
    return bool(e) and e in normalize_text(page_text)
