# Swissquote → eCH‑0196 E‑Steuerauszug Converter

A small web app that turns a **Swissquote transactions CSV export** into the
official Swiss **eCH‑0196 electronic tax statement (E‑Steuerauszug) XML** that
you can import into your cantonal tax‑declaration software. It asks you for the
few fields the CSV doesn't contain, and shows a dashboard summarising your
**Zugänge** (purchases), **Abgänge** (disposals) and **Dividenden**.

It reuses the official eCH‑0196 data models and XSD schema from the
[`opensteuerauszug`](https://github.com/vroonhof/opensteuerauszug) project, so
the generated XML is validated against the real schema (eCH‑0196 v2.2) before
you download it.

![workflow: upload CSV → answer a few questions → dashboard + validated XML download]

---

## Quick start

```bash
./run.sh            # creates .venv, installs deps, serves http://127.0.0.1:8000
```

Then open <http://127.0.0.1:8000>, upload your
`transactionsfrom01012025to31122025.csv`, fill in the form, and download the
XML.

Manual setup instead of `run.sh`:

```bash
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn backend.main:app --port 8000
```

Run the tests:

```bash
pip install -r requirements-dev.txt
pytest
```

---

## How it works

```
CSV bytes ─▶ csv_parser ─▶ classifier ─▶ statement_builder ─▶ eCH‑0196 XML
                              │                                    │
                              └────────▶ summary ─▶ dashboard      └▶ XSD validation
```

| Module | Responsibility |
|--------|----------------|
| `backend/csv_parser.py` | Decode Latin‑1 / `;`‑separated export into typed `Transaction`s |
| `backend/classifier.py` | Bucket transactions per security, reconstruct year‑end positions |
| `backend/statement_builder.py` | Build the eCH‑0196 `TaxStatement` (reuses `opensteuerauszug` models) |
| `backend/summary.py` | Aggregate the dashboard figures |
| `backend/validation.py` | Validate the XML against the vendored eCH‑0196 XSDs (`specs/`) |
| `backend/main.py` | FastAPI app (`/api/analyze`, `/api/generate`) + serves `frontend/` |
| `frontend/` | Zero‑dependency single‑page UI (upload → questions → dashboard) |

### How each Swissquote transaction type is mapped

| Swissquote type | eCH‑0196 treatment |
|-----------------|--------------------|
| `Kauf`, `Buy-to-Open` | Security stock movement **+** (Zugang) |
| `Verkauf` | Security stock movement **−** (Abgang) |
| `Dividende`, `Capital Gain` | Security income (revenue **A** for Swiss ISINs incl. 35 % Verrechnungssteuer claim, **B** for foreign) |
| `Zinsen auf Einlagen` | Bank‑account interest (revenue A) |
| `Titelumbuchung`, `Ausübung(von Anrechten)`, `Ausgabe von Anrechten`, `Expiration`, `Rückzahlung` | Corporate actions → stock movements |
| `Forex‑*` in `XAU` | Aggregated into one gold (`COINBULL`) position |
| `Depotgebühren`, `Berichtigung Börsengeb.` | Fees (shown in the summary; not taxable income) |
| `Kartentransaktion`, `Fx‑*`, `Forex‑*` (cash), `Zahlung` | Pure cash‑account movements — **excluded** from the securities statement |

Instruments are recognised as **shares**, **funds/ETFs**, **options/warrants**
(Swissquote `SQ…`/`XB…` identifiers) or **crypto** (`EX0X00…` identifiers);
options, crypto and metals can each be toggled off in the form.

---

## Important limitations — please read

This tool produces a **useful, schema‑valid draft**, not an official bank
document. Specifically:

- **Not bank‑signed.** A real E‑Steuerauszug is issued and digitally signed by
  the bank. This is a self‑generated statement. Cantonal software imports it as
  a manual/assisted import; it takes over the quantities and income and lets you
  review/complete the values.
- **The CSV has no opening holdings and no year‑end market prices.** It only
  contains transactions. Therefore:
  - **Opening balances** for securities held *before* the tax year are
    *inferred* whenever a sale exceeds the in‑year purchases (flagged
    “rekonstr.” in the dashboard). Positions you held all year but never traded
    do **not** appear at all — add them manually if needed.
  - **Year‑end tax values (Steuerwert per 31.12)** are *estimated* from the last
    trade price × your FX rate and marked `kursliste="true"`, so your tax
    software replaces them with the official Kursliste values. Treat every
    “Schätz.” figure as indicative.
- **FX rates are estimates.** The CHF totals use the editable rates you enter
  (pre‑filled with rough year‑end values). Per‑position amounts are kept in the
  original currency; the tax software recomputes CHF from official rates.
- **Foreign withholding tax (DA‑1 / US additional withholding) is not claimed.**
  It is reported in the dashboard for your awareness but left for you / the tax
  software to handle.

Always review the generated statement against your Swissquote year‑end documents
before submitting. **This is not tax advice.**

---

## Project layout

```
backend/     FastAPI app + conversion pipeline
frontend/    index.html · styles.css · app.js  (no build step, no CDN)
specs/       Vendored eCH‑0196 v2.2 XSD schemas (public eCH standards)
sample_data/ Anonymised sample export used by the tests
tests/       pytest suite (parser, classifier, builder+XSD, API)
run.sh       One‑command dev server
```
