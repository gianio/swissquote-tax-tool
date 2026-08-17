# Browser‑only PoC — client‑side Swissquote → eCH‑0196 XML

This folder is a **proof of concept for the public‑service direction**: the whole
conversion runs **in the visitor's browser**, with **no server**. It's a set of
static files you can drop on any static host (GitHub Pages, Netlify, S3, a plain
web domain) — the visitor's financial data never leaves their device.

## What it proves

- `core.js` is a framework‑free JavaScript port of the Python pipeline
  (CSV parse → classify → position reconstruction → **eCH‑0196 XML**), runnable
  in both the browser (`window.SQCore`) and Node (`require`).
- The generated XML is **schema‑valid** against the official eCH‑0196 v2.2 XSD —
  verified in CI: `tests/test_web_poc.py` runs `core.js` through Node and
  validates the output with the same validator used for the Python backend.
- `index.html` + `app.js` are a minimal UI (upload → form → generate → download),
  loaded even from `file://` — no build step, no backend, no network calls.

## Try it

Just open `web/index.html` in a browser, or serve the folder statically:

```bash
cd web && python3 -m http.server 8080   # then open http://localhost:8080
```

Quick CLI check (same core, via Node):

```bash
node web/cli.js path/to/transactions.csv 2025 GR > statement.xml
```

## Scope of the PoC vs. the full app

This PoC intentionally covers only the **CSV → XML** slice to validate the
architecture. Still **to port to JS** for a full public service:

1. **PDF417 barcode PDF** — the make‑or‑break piece (today Python
   reportlab + pdf417gen). Needs `pdf-lib` + a JS PDF417 library.
2. **Kontoauszug PDF parsing** — via `pdf.js` (coordinate extraction), incl.
   cash balances + identity.
3. **Dashboard** (Zu‑/Abgänge, Dividenden) — reuse the existing chart code.
4. **Legal shell** — privacy policy, disclaimer, de‑branding of the output.

See the repo root `README.md` for the server version (fully featured today).
