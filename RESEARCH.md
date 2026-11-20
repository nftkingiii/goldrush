# Gold Rush miners: research notes

Read-only research, 2026-11-20. Everything below was inspected on that date; "not checked" means exactly that.
Data fetched with keyless GET requests under the user agent `goldrush-miner/0.1 (research; ...)`; nothing was registered, deployed, signed, paid or posted.

## 1. What the app lead already covers, and the gap

App: https://oathcastcourt.duckdns.org/gold-rush. Read-only GETs worked: `/gold-rush/api/sites` (8,132 gold workings: `site_no`, `name`, `sheet`, `lat`, `lon`, `band`), `/gold-rush/api/specialists` (miners whose RESEARCH_QUERY_GENERAL catalogue entry names gold, mining, geology or Queensland), `/gold-rush/api/ledger` (public paid calls).

- The app asks each specialist one fixed question: "Tell me about the Mount Morgan gold mine, Queensland: who owned it, how much gold it produced, and when and why it closed." (the earlier variant said "the MOUNT MORGAN gold mine near MOUNT MORGAN, Queensland"). It sends the name, not the site number.
- Each call is $0.01 test USDC from the app's escrow. Answers are shown as `answer`, `sources`, `brief`, plus a keyword check of four topics: ownership, production, closure, gold price. "nobody" marks a gap.
- Miner 64176 (OathCast Queensland Gold Mines) returns, for Mount Morgan: site number 494270, "abandoned mine", location, "giant, over 150 tonnes", other commodities, 37 other workings within 5 km, and "The record provides a size band but no production figures, owners, or closure dates." Its sources are the MINOCC ArcGIS query URL and the GSQ dataset page.
- Ledger observation: the first call to 64176 on 2026-11-20 13:33 UTC is recorded as `paid_refusal`, then a second call "served". Why is unknown (open question 4).

So the gap is real and matches our promise: production, closure reasons, ownership and gold price at the time are held by nobody.

## 2. Datasets

| Dataset | Production | Closure | Owners/tenure | QLD gold coverage | Access | Licence | Size |
|---|---|---|---|---|---|---|---|
| **GSQ MINOCC "Historical workings" layer** (ArcGIS MapServer layer 16) | no | no | no (only status, size band, commodities) | 8,132 gold sites of 15,317 | Keyless ArcGIS REST, JSON, max 2,000 per page. Used. | Dataset ds000004 "Queensland Mineral Occurrence Data": "License Creative Commons Attribution 4.0" (read on data.qld.gov.au listing) | 3.3 MB raw, 1.5 MB compact index |
| **MINOCC full database / QMIN** (via GSQ Open Data Portal) | The dataset text says QMIN "contains all data on small, medium, large and giant mines and resources, including their historic and current production and resource data" | not stated | not stated | Presumably the 4 largest size bands, not verified | Portal (geoscience.data.qld.gov.au) answers HTTP 403 / empty page to automated clients and the Browser pane. Download link and format not seen. **Needs a human to download.** | CC BY 4.0 on the listing | unknown |
| **GSQ Open Data Portal / QDEX company reports (CR numbers)** | in PDFs | in PDFs | in PDFs | thousands of reports, unindexed | Same 403. A CR comments page on data.qld.gov.au exists (`/geoscience/cr040949/comments`). Reports are scanned or text PDFs: not machine-readable at scale | per report, not checked | n/a |
| **data.qld.gov.au** (CKAN) | Annual mineral and metal statistics: state totals by commodity, 1877 to FY2024-25 (guide PDF, 1989-2021 ZIP, XLSX). **Not per mine.** | no | no | state-wide only | The site returned 504 for most of the session; the CKAN `package_search` API timed out. `data.gov.au` mirrors metadata and worked. Data files not downloaded | `cc-by-4` on the metadata | small |
| **Mineral leases 1871 to 1940** (Queensland State Archives index) | no | no | lessee/lease index "from the Mines Department and the Mining Warden, **Cloncurry**" only | one warden district | CSV link found; download returned an empty 202, then timed out. Not fetched | `cc-by-4` on the data.gov.au metadata | unknown |
| **Queensland mining and exploration tenure series** | no | no | tenure (current/recent), not checked in detail | modern tenures | listed on data.gov.au, `cc-by-4`. Not inspected | cc-by-4 | unknown |
| **GeoResGlobe** | not checked | not checked | not checked | not checked | Not reached. No evidence it is a bulk or API source | unknown | unknown |
| **Geoscience Australia OZMIN, live WFS** `services.ga.gov.au/gis/earthresource/wfs` | **No production field.** Layers give resources/reserves (`ama:ReservesAndResources`), deposit size (`ama:MineralDepositsSizes`), companies | status only ("historic mine") | `COMPANIES` = current company list | 937 Queensland deposits, 288 with gold. Mount Morgan is ENO 333486 ("historic mine", Heritage Minerals Pty Ltd). Charters Towers is one deposit (care and maintenance, Citigold) not per lode | Keyless WFS, GeoJSON, CQL filter. Used for owner and status | Service AccessConstraints, quoted: "released free under the Creative Commons Attribution 4.0 International Licence" | 288 rows = 44 KB |
| **GA OZMIN, data.gov.au bulk ZIP** (2013 BA snapshot) | no | no | no | **Coal only** (files `Cbl_`/`Cbr_deposits_resources_for_2012`). Useless for gold | direct ZIP, 122 KB | CC BY 3.0 AU on one listing, "not specified" on others | 122 KB |
| **GA "Gold deposits of Queensland: BMR datafile (MINDEP)"** | legacy product, probably per-deposit production (Res_Rep_04 PDF) | unknown | unknown | gold, Queensland | PDF link on a CloudFront URL, not downloaded | "notspecified" | unknown |
| **World Bank Pink Sheet** `CMO-Historical-Data-Monthly.xlsx` | n/a: gold price | | | | Keyless direct XLSX (587 KB), "Updated on November 03, 2026". Gold column, US$/troy oz, **monthly average, published as whole dollars**, 1960M01 to 2026M10 (802 months). Used | The World Bank terms pages were unreachable (generic terms page only). A third-party mirror of the Data Catalog lists the Commodity Markets dataset as `cc-by`. **CC BY 4.0 is therefore reported, not verified on the Pink Sheet page.** | 587 KB |
| **RBA statistical table F11 (exchange rates)** | n/a | | | | `curl` gets HTTP 403 from rba.gov.au (bot block; I did not try to evade it). The Browser pane read the files normally: monthly CSV (2010 to Oct 2026) and `f11hist-1969-2009.xls`. Month-end A$1=US$, starting Nov 1970 in the file. I extracted the values in the browser and stored them under `data/raw/` | RBA copyright page, quoted: "most other material published on this website is provided under a Creative Commons Attribution 4.0 International License" | tiny |

Other inspected sources used as curated evidence (each is one cited page, quoted):
- Queensland Government, Mount Morgan remediation page (qld.gov.au): "about 250 tonnes of gold and 360,000 tonnes of copper", operations "until November 1990", leases transferred to Heritage Minerals in 2020. Footer "(c) The State of Queensland 1995 - 2026"; page-level licence not verified.
- Wikipedia (API extracts, revision ids pinned): Mount Morgan Mine (262 t gold, 1882-1981, 1927 fire, Peko-Wallsend, Norton Gold Fields), and two Queensland Heritage Register entries republished on Wikipedia (Day Dawn mine remains; Charters Towers mine shafts). Wikipedia text is CC BY-SA 4.0 (share-alike applies to the quoted text); the underlying Heritage Register text is the State of Queensland's, CC BY 4.0.

**Conclusion.** No keyless open bulk dataset gives per-site reported production, closure reasons or ownership history for Queensland gold. The only open structured source (GA) gives current companies and resources. Production and closure text lives in (a) the full MINOCC/QMIN database, (b) QDEX/CR PDFs, (c) historic compilations such as MINDEP, and (d) narrative pages such as Heritage Register entries. (a) and (b) are behind a portal that refuses automated clients, so they need a person to download or an explicit decision on how to access them. The miner is therefore built so that coverage is a curated, quote-verified set that can grow without code changes; everything else answers `not_found`.

## 3. Intents

Source: `GET https://devnode.telegraphprotocol.com/engine/v1/intents/<id>` and `/engine/v1/intents` (136 intents), `anjoman.ai/api/explorer/canonical-intents` (same names, 136).

- **RESEARCH_QUERY_GENERAL**: class `judgment`, 30 miners, lifecycle active. Request: `question` (string, required, on-chain `max_bytes` 256). Response fields: `answer` (string), `source_count` (integer 0-1000), `sources` (list of URLs or names), `brief` (string, at most 80 characters, processed on-chain). No comparator, no scored numeric field. Extra fields in our JSON are allowed off-chain.
- **CONTENT_EXTRACTION_GENERAL**: class `judgment`, 22 miners. Request: `content` (the content or a URL) and `fields` (what to extract). Response: `title`, `content`, `url`, `entities`, `brief`. It extracts from content the caller supplies, so it is not the home for a question about a mine. Possible later use: a caller supplies a CR report and asks for production and closure fields.
- **Historical gold price, best fit**: there is no commodity intent. Candidates:
  - FINANCIAL_DATA_GENERAL: concept fits ("market data ... beyond a single quoted price") but it is `deterministic` with a comparator on `market_cap_usd` (code 2, 200 bps, keys Bitcoin and Ethereum), request has only `asset`, no date. A gold-price miner would be tested on Bitcoin market caps and fail.
  - MACRO_ECONOMIC_INDICATOR_GENERAL: `deterministic`, `indicator` is an enum with the single value "unemployment rate", requires `country` and `year`.
  - CRYPTO_PRICE_USD, STOCK_PRICE_US_EQUITY, FX_NOW_*: current price only, other assets.
  - **Chosen: RESEARCH_QUERY_GENERAL.** Judgment class, free-text question carries the month or range, `sources` carries the series URL, and it is the intent the app already calls.
- Miner YAML and registration docs read: yaml-config, miner-registration, validation-api (the public validate endpoint answers 404, so validation is the web interface at anjoman.ai/dashboard/earn or a `registerMiner` dry run). Rules that shaped the YAMLs: intents only (no prefixes); each endpoint needs `description`, `intents`, `params`; schema blocks are closed sets; `input_schema` is top-level only; `intent_mapping` is optional and lets the node read `answer`, `source_count`, `sources` by path.

## 4. What was built

Folder `C:\Users\USER\Documents\Telegraph\GoldRush`, own local git repo, no remote.

- `src/app.ts`, `answer.ts`, `match.ts`, `price.ts`, `store.ts`: question to site resolution, record assembly, price lookup. `src/sources.ts`, `zip.ts`: parsers for GSQ, GA, Pink Sheet (XLSX read with an in-repo ZIP reader) and RBA, with injected `fetch`. `src/server.ts`: `GET /ask`, `GET /price`, `/health`, the two YAMLs, per-IP limit of 30 a minute. The service reads only its local snapshot; it makes no outbound call while answering.
- `data/index.json` (8,132 GSQ gold sites, 288 GA deposits, dataset names, licences and fetch dates), `data/gold-monthly.json`, `data/evidence.json` (25 curated records, 4 sources), `data/raw/` (RBA values, GA rows). `scripts/` rebuilds each of them.
- `miners/goldrush-qld-history.yaml` (id 7310050) and `miners/goldrush-gold-price.yaml` (id 7310051). Both free on the devnode list on 2026-11-20.
- `eval/pairs.jsonl`: 18 preference pairs, `scripts/make-eval-pairs.ts` regenerates them.

Rules the code enforces: every production, closure and ownership row carries `source_ref`, `source_url` and a verbatim `quote`, and a test checks each quote is in the recorded page; closure `reason_class` is `unknown` unless the quoted text states the cause; records from different sources are never merged (conflicts are listed, all values kept); no evidence means `not_found`; a name that exists only on a different 1:100,000 map sheet than the one asked about is refused; same-name same-size sites are refused as ambiguous.

Honest limits: curated coverage is Mount Morgan (494270), Day Dawn lode (38730, three mines on the lode) and Brilliant lode (38722). The 8,129 other sites answer with the GSQ record and `not_found`. Australian dollar prices are derived (World Bank monthly average divided by RBA month-end rate) and are labelled so; the pre-1960 gold price is `not_found`.
