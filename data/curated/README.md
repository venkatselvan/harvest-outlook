# Curated data: licence and attribution

This directory holds curated, versioned records derived from retrieved public sources. Raw source files stay in `data/raw/`, which is gitignored and private. Each subdirectory or file family lists its own provenance. This file covers the ICAR agronomy evidence written by task T05b (`evidence/ginger.*`, `stages/ginger.*`, `rules/ginger.*`). Other families, such as `openmeteo/`, have their own README.

## ICAR publications used

| Source | Publisher | Version | SHA-256 | Licence statement found in the PDF |
| --- | --- | --- | --- | --- |
| [Ginger (extension guide, English)](https://spices.res.in/storage/app/public/pdfs/GINGER/3ENG.pdf) | ICAR-Indian Institute of Spices Research, Kozhikode | Imprint "February 2025"; PDF CreationDate 2025-03-10 | `8dde754dc3defc1c116fd11e963b091870e463b99f7c601a040f1aae0f1fe65e` | **unstated**: no copyright or licence text on any extractable page. Page 1 (cover) and pages 30-32 have no extractable text, so a statement printed only as an image there would not have been detected. |
| [Agriculture Contingency Plan for District: HASSAN (KA28)](https://www.icar-crida.res.in/CP-2012/statewiseplans/Karnataka%20(Pdf)/GKVK,%20Bangalore/KA28-Hassan%20%2004.10.2011.pdf) | ICAR-Central Research Institute for Dryland Agriculture | 2011-10-04 (file name and PDF CreationDate) | `8e1d6636773a5714c3110a7908815baf0e6dc2736ec77bf96dda5ea8322ddd6a` | **unstated** in the PDF (all 42 pages have text). The publisher's index page (`data/raw/crida/index.html`) has the footer: "© Copyright ICAR-CRIDA . All Rights Reserved". The source HTML uses `&copy;` and extra spaces, which are collapsed here. |

Retrieval times and URLs are in `data/raw/fetch_log.jsonl` (ids `iisr-ginger-guide` and `crida-hassan`).

## Use terms applied

- Neither PDF grants a licence, so the records set `licence.redistributable: false` and `accessStatus: open`, meaning the PDFs are publicly downloadable but no reuse grant was found. The source PDFs are not redistributed.
- Evidence records contain only short native excerpts, each 60 words or fewer, with page citations. Each record names the publisher, title and version. The suggested attribution string is in `licence.attribution`.
- Excerpts are quoted as pypdf extracted them, including spacing artifacts such as "pla nting". They are not edited.
- Chemical control measures from both documents are deliberately excluded (PRD 9.2).
- Before publishing a public build that shows these excerpts, a rights review is required. Fable or the user must decide whether short cited excerpts from ICAR publications are acceptable.
