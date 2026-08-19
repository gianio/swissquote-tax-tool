# Vendored third-party dependencies

Everything the browser‑only app needs is vendored here so it runs **fully
offline** — no CDN, no external network. Provenance and licences:

| Path | Package | Version | Licence |
|------|---------|---------|---------|
| `pdf.min.js`, `pdf.worker.min.js` | [pdf.js](https://github.com/mozilla/pdf.js) (Mozilla) | 3.11.174 | Apache‑2.0 |
| `pdf-lib.min.js` | [pdf-lib](https://github.com/Hopding/pdf-lib) | 1.17.1 | MIT |
| `pyodide/` | [Pyodide](https://github.com/pyodide/pyodide) (CPython‑in‑WASM) | 0.26.2 | MPL‑2.0 |
| `pdf417gen/` | fork of [pdf417gen](https://github.com/vroonhof/pdf417gen) | fork | MIT |

Notes:

- **`pdf417gen/`** is a trimmed copy of the `vroonhof` fork (the same one the
  server uses), with `encode_macro` for eCH‑0196 macro‑PDF417 file‑name
  compaction. PIL‑based rendering is stripped; `rendering.py` only exposes
  `barcode_size`/`modules` (coordinate output), which `barcode.js` draws with
  pdf‑lib. It is imported into Pyodide's virtual FS at runtime — pure Python,
  no native deps.
- **`pyodide/`** carries only the core runtime (`pyodide.asm.*`,
  `python_stdlib.zip`, `pyodide-lock.json`); no extra wheels are loaded.

Licence texts ship inside the minified bundles / packages themselves.
