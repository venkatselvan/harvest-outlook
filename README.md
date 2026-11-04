# Harvest Outlook

Harvest Outlook is a progressive web app for Indian farmers. It compares crops for a farm's location, plans seasons visually, shows a daily "Today" view for each field, and keeps a farm journal. An assistant called Evara answers questions about the farm using the farm's own records, and accepts voice input.

Live demo: link added after deployment

## Features

- **Farms and fields.** Draw a farm and the fields inside it on a satellite map. Each field has its own crops, Today view, plan and records. An "All farms" overview shows every farm at a glance.
- **Today view.** Per-field weather and forecast, crop stage, upcoming steps, alerts (weather, price, crop-threat rules, satellite greenness drop), Sentinel-2 vegetation indices, a profit and footprint estimate, and AI-predicted looks of the field at a future stage. Predicted looks are labelled as generated images.
- **Crop fit.** Ranks crops for a field by sowing date, by season, or for the next crop, using a catalogue of 25 crops and the farm's soil, water and rotation history.
- **Year plan.** Suggests crop sequences for the current year and up to three later years, with plan labels, rotation, green manure and intercropping options, and profit ranges from regional yields and past prices. Saved seasons can be swapped.
- **Season preview.** A calendar of stages, typical weather, a price path and care steps for a chosen crop and sowing date.
- **Market timeline.** Historical mandi price ranges by week, and the latest recorded quotes, for the crops the price data covers.
- **Journal.** Dated entries with photos, expenses and sales, care completion, field checks and an issue log with responses. Season totals and a printable season report with CSV export.
- **Soil report review.** Upload or enter a soil test report, confirm the values, and see them rated against published bands and compared with the crops in the plan.
- **Photo coverage.** Mark the planted area on a field photo and estimate the coverage share.
- **Evara assistant.** Chat grounded in the farm briefing and a curated evidence set, with inline voice input (editable transcript, text answers).
- **Offline PWA.** Installable, caches the app shell, and keeps journal drafts on the device when offline.

## Tech stack

- Web: SolidJS, Vite, Leaflet, a service-worker PWA (vite-plugin-pwa, Workbox).
- API: Fastify 5 with Zod contracts, TypeScript.
- Database: PostgreSQL.
- Worker: a background job process for data ingest, plan and crop-fit jobs, monitoring and image jobs.
- Analytics: a Python package (`analytics/`) for forecasting and evaluation (numpy, pandas).
- AI: Meta models only, used at runtime for interpretation, vision, constrained orchestration, image generation and speech recognition. Speech recognition is for voice input only; there is no speech synthesis.
- Forecasting, rules, arithmetic, water balance and animation are plain code, not AI. Models do not produce numbers shown as results.

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/api` | Fastify API, providers, services and the job worker |
| `apps/web` | SolidJS PWA and Playwright end-to-end specs |
| `packages/contracts` | Shared Zod schemas and exported JSON schemas |
| `packages/domain` | Shared domain logic (arithmetic, rules, plan engine pieces) |
| `db/migrations` | SQL migrations |
| `scripts` | Seed, catalogue build and validation, replay and smoke scripts |
| `analytics` | Python forecasting and evaluation package with tests |
| `data` | Curated crop catalogue, source manifests, research reference data used at runtime, fixtures |
| `evals` | Evaluation cases and labels |

## Run locally

Requirements: Node 24 or newer, pnpm 10, PostgreSQL 16 or newer (PostGIS is not needed), and Python 3.12 or newer if you want to run the analytics tests.

```sh
pnpm install

createdb harvest_outlook_dev
createdb harvest_outlook_test      # throwaway database; the tests wipe it

cp .env.example .env               # then set SESSION_SECRET (32+ characters), DATABASE_URL, TEST_DATABASE_URL
pnpm db:migrate
pnpm db:seed

pnpm dev                           # API on :8787, web on :5173 (Vite proxies /api)
pnpm --filter @harvest/api run worker   # in a second terminal: background jobs
```

Open http://localhost:5173. `.env.example` names a `harvest` database role; create it, or change the URLs to a role you have (for example `postgres://localhost:5432/harvest_outlook_dev`).

`RUNTIME_MODE` in `.env` selects the data path:

- `synthetic` (default): labelled synthetic fixtures, no provider keys, no cost.
- `replay`: replays recorded provider responses.
- `live`: calls real providers. You must supply your own keys in `.env` (`MODEL_API_KEY` for the Meta models, and `DATA_GOV_IN_API_KEY` for mandi prices). Open-Meteo and the satellite source need no key. Live mode may incur provider charges.

Checks:

```sh
pnpm typecheck
TEST_DATABASE_URL=postgres://localhost:5432/harvest_outlook_test pnpm test
pnpm catalogue:validate
python3.12 -m venv analytics/.venv && analytics/.venv/bin/pip install -e 'analytics[dev]'
pnpm analytics:test
pnpm --filter @harvest/web exec playwright install && pnpm test:e2e
```

The saved source pages under `data/raw/` are not part of the repository. Without them `pnpm catalogue:validate` skips its excerpt-in-source check and the seed stores catalogue evidence as `pending` instead of `grounded`.

## Data sources and attribution

- **Weather:** Open-Meteo.com (archive and forecast; ERA5 reanalysis from the Copernicus Climate Change Service), licensed CC BY 4.0, https://open-meteo.com/en/licence. The free tier is for non-commercial use only. Attribution shown in the app: "Weather data by Open-Meteo.com".
- **Satellite vegetation:** Sentinel-2 L2A imagery, "Contains modified Copernicus Sentinel-2 data", served by Microsoft Planetary Computer (Preview service, Sentinel data licence).
- **Basemap:** Esri World Imagery (Imagery © Esri, Maxar, Earthstar Geographics) and OpenStreetMap tiles, credited on the map.
- **Mandi prices:** data.gov.in / AGMARKNET (Directorate of Marketing and Inspection via the Open Government Data Platform India). The portal states GODL-India. Needs your own free API key.
- **Administrative boundaries:** geoBoundaries (gbOpen) for locating a farm's state and district; the source and licence are recorded with each lookup.
- **Crop evidence:** short cited excerpts (60 words or fewer) from ICAR institutes (IISR, CRIDA, IIMR), Tamil Nadu Agricultural University, Assam Agricultural University, Spices Board India and the National Horticulture Board. Publisher licences are mostly unstated, so the source documents are not redistributed and each excerpt names its publisher.
- **Reference data:** state and district lists from the Governments of Karnataka, Tamil Nadu and Assam (names only); soil rating bands, intercropping and cost-of-cultivation research data are in `data/research` with sources noted in the files.
- **Software:** open-source dependencies under their own licences (MIT, Apache-2.0, BSD and similar), including Fastify, SolidJS, Vite, Leaflet, sharp, numpy and pandas.
- **Meta models:** Muse Spark (text, vision, tools), Muse Image (image generation and editing), SAM 3.1 (region proposals) and Muse Voice Transcribe (speech recognition), through the Meta Model API.

## Limitations

- Generated crop appearances and predicted satellite looks are illustrative. They are not biological predictions or field observations.
- Regional coverage varies by crop. Several crops rest on evidence from one state only (for example Tamil Nadu only or Assam only), and most stage dates are generic FAO-56 estimates; only ginger has a sourced stage model.
- Price history is strongest for Karnataka; other states have partial or no history. Price ranges are historical references, not forecasts, and the unit is treated as INR per quintal.
- Yields are regional statistics, not predictions for a field. Cost of cultivation is missing for some crops, so some plans show no profit.
- Spectral indices and the NDVI stage reader are not validated against field observations.
- The demo farm is a labelled sample record written by code. It is not an observation of any real farm or farmer.
- Speech recognition is unqualified for agricultural vocabulary in English, Tamil and Hindi. The UI is English only.

## Author

Venkat Selvan

## License

No license has been chosen yet; all rights reserved.
