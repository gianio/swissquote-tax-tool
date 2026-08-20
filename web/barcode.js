/*
 * Client-side eCH-0196 barcode PDF (macro PDF417), fully offline.
 *
 * The macro-PDF417 encoding is the make-or-break part, so instead of
 * re-implementing it we run the *exact* proven Python encoder (pdf417gen, the
 * same fork the server uses) in the browser via a vendored Pyodide — no CDN,
 * no network. Python returns the black-module coordinates per barcode segment;
 * pdf-lib (JS) draws them into a PDF. This yields a barcode byte-identical to
 * the server's for the same statement.
 *
 * Exposes window.SQBarcode.generate(xml, opts) -> Promise<Uint8Array> (PDF).
 */
(function (root, factory) {
  root.SQBarcode = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PDF417GEN_FILES = [
    "__init__.py", "encoding.py", "error_correction.py", "codes.py",
    "data.py", "util.py", "types.py", "rendering.py",
    "compaction/__init__.py", "compaction/byte.py", "compaction/numeric.py",
    "compaction/optimizations.py", "compaction/text.py",
  ];

  const PY_ENCODER = `
import sys
sys.path.insert(0, "/p417")
import zlib, hashlib
from math import floor
from pdf417gen import encode_macro, barcode_size, modules
from pdf417gen.compaction import compact_text

def make_barcodes(xml, file_name, creation_ts):
    data = zlib.compress(xml.encode("utf-8"), 9)
    FIXED_OVERHEAD = 46
    NUM_COLUMNS = 13
    NUM_ROWS = 35
    fnc = list(compact_text(bytes(file_name, "utf-8")))
    capacity = NUM_COLUMNS * NUM_ROWS - FIXED_OVERHEAD - (len(fnc) + 1)
    segment_size = floor((capacity / 5) * 6)
    digest = hashlib.sha256(("%s_%s" % (file_name, creation_ts)).encode("utf-8")).digest()
    file_id = [100 + (b % 156) for b in digest[:4]]
    codes = encode_macro(data, file_id=file_id, file_name=file_name,
                         columns=NUM_COLUMNS, force_rows=NUM_ROWS, security_level=4,
                         segment_size=segment_size, force_binary=True)
    out = []
    for bc in codes:
        w, h = barcode_size(bc)
        rows = [[] for _ in range(h)]
        for x, y in modules(bc):
            rows[y].append(x)
        out.append({"w": w, "h": h, "rows": rows})
    return out
`;

  let pyodidePromise = null;

  async function getPyodide(onProgress) {
    if (pyodidePromise) return pyodidePromise;
    pyodidePromise = (async () => {
      if (typeof loadPyodide === "undefined") {
        await new Promise((res, rej) => {
          const s = document.createElement("script");
          s.src = "vendor/pyodide/pyodide.js";
          s.onload = res; s.onerror = () => rej(new Error("Pyodide konnte nicht geladen werden."));
          document.head.appendChild(s);
        });
      }
      onProgress && onProgress("Lade Python‑Laufzeit (einmalig) …");
      const py = await loadPyodide({ indexURL: "vendor/pyodide/" });
      onProgress && onProgress("Lade Barcode‑Encoder …");
      // Write the vendored pdf417gen source into Pyodide's virtual filesystem.
      // (Use a fresh mount point — /lib already exists in Pyodide.)
      const mkdir = (p) => { try { py.FS.mkdir(p); } catch (e) { /* EEXIST */ } };
      mkdir("/p417");
      mkdir("/p417/pdf417gen");
      mkdir("/p417/pdf417gen/compaction");
      for (const rel of PDF417GEN_FILES) {
        const resp = await fetch("vendor/pdf417gen/" + rel);
        if (!resp.ok) throw new Error("Barcode-Datei fehlt: " + rel);
        py.FS.writeFile("/p417/pdf417gen/" + rel, await resp.text());
      }
      py.runPython(PY_ENCODER);
      return py;
    })();
    return pyodidePromise;
  }

  // Merge consecutive black modules in a row into runs (fewer PDF rects).
  function runs(xs) {
    if (!xs.length) return [];
    xs.sort((a, b) => a - b);
    const out = [];
    let start = xs[0], prev = xs[0];
    for (let i = 1; i < xs.length; i++) {
      if (xs[i] === prev + 1) { prev = xs[i]; continue; }
      out.push([start, prev - start + 1]); start = xs[i]; prev = xs[i];
    }
    out.push([start, prev - start + 1]);
    return out;
  }

  // Layout per "Beilage zu eCH-0196 V2.2.0 – Barcode Generierung – Technische
  // Wegleitung" (matched to the server's opensteuerauszug/reportlab renderer,
  // which is known-good against real tax software): landscape A4, barcodes
  // rotated 90° and laid out 6-per-page in a single row, module size
  // 0.42mm (per original column) x 0.4mm-per-pixel-row (x2 ratio = 0.8mm per
  // PDF417 row). A generic barcode reader (zxing) decodes our un-rotated
  // barcode fine, but softax's own importer apparently expects this exact
  // physical layout to even recognise the file — hence matching it exactly.
  const MM = 2.834645669291339; // pt per mm
  const PAGE_W_MM = 297, PAGE_H_MM = 210; // landscape A4
  const MARGIN_LEFT_MM = 24, MARGIN_RIGHT_MM = 13, MARGIN_TOP_MM = 40, MARGIN_BOTTOM_MM = 18;
  const MODULE_COL_MM = 0.42;      // per original column -> final rotated height
  const MODULE_ROW_PIXEL_MM = 0.4; // per pixel-row; x RATIO -> final rotated width
  const RATIO = 2;
  const BARCODES_PER_ROW = 6;

  async function generate(xml, opts, onProgress) {
    opts = opts || {};
    const py = await getPyodide(onProgress);
    onProgress && onProgress("Erzeuge Barcodes …");
    const fn = py.globals.get("make_barcodes");
    const resultProxy = fn(xml, opts.statementId || "STATEMENT", String(opts.creationTs || 0));
    const barcodes = resultProxy.toJs({ dict_converter: Object.fromEntries });
    resultProxy.destroy(); fn.destroy();

    onProgress && onProgress("Baue PDF …");
    const { PDFDocument, rgb, StandardFonts } = PDFLib;
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const fontB = await pdf.embedFont(StandardFonts.HelveticaBold);

    const PAGE_W = PAGE_W_MM * MM, PAGE_H = PAGE_H_MM * MM;
    const ML = MARGIN_LEFT_MM * MM, MR = MARGIN_RIGHT_MM * MM;
    const MT = MARGIN_TOP_MM * MM, MB = MARGIN_BOTTOM_MM * MM;
    const usableWidth = PAGE_W - ML - MR;
    const colWidth = usableWidth / BARCODES_PER_ROW;
    const rowWidthPt = RATIO * MODULE_ROW_PIXEL_MM * MM;  // per PDF417 row, after rotation
    const colHeightPt = MODULE_COL_MM * MM;                // per original column, after rotation
    const black = rgb(0, 0, 0);

    const pageCount = Math.max(1, Math.ceil(barcodes.length / BARCODES_PER_ROW));
    let page = null;
    const newPage = (pageNum) => {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      page.drawText("Swissquote - eCH-0196 E-Steuerauszug", { x: ML, y: PAGE_H - MT + 20, size: 12, font: fontB });
      page.drawText(
        `Steuerjahr ${opts.taxYear || ""} - Barcode (macro PDF417) - nicht bank-signiert - Seite ${pageNum + 1} / ${pageCount}`,
        { x: ML, y: PAGE_H - MT + 6, size: 8, font, color: rgb(0.3, 0.3, 0.3) }
      );
    };

    for (let bi = 0; bi < barcodes.length; bi++) {
      const pageNum = Math.floor(bi / BARCODES_PER_ROW);
      const slot = bi % BARCODES_PER_ROW;
      if (slot === 0) newPage(pageNum);

      const bc = barcodes[bi];
      const rotatedWidth = bc.h * rowWidthPt;   // rows -> horizontal extent
      const rotatedHeight = bc.w * colHeightPt; // columns -> vertical extent
      const originX = ML + slot * colWidth + (colWidth - rotatedWidth) / 2;
      const originY = MB;

      page.drawText(`${bi + 1}/${barcodes.length}`, {
        x: originX, y: originY + rotatedHeight + 4, size: 7, font, color: rgb(0.4, 0.4, 0.4),
      });

      for (let r = 0; r < bc.rows.length; r++) {
        const xBand = originX + r * rowWidthPt;
        for (const [start, len] of runs(bc.rows[r])) {
          page.drawRectangle({
            x: xBand, y: originY + start * colHeightPt,
            width: rowWidthPt, height: len * colHeightPt,
            color: black,
          });
        }
      }
    }
    return await pdf.save();
  }

  // For tests/verification: return the raw barcode module data (pre-PDF).
  async function _encode(xml, opts) {
    const py = await getPyodide();
    const fn = py.globals.get("make_barcodes");
    const proxy = fn(xml, (opts && opts.statementId) || "STATEMENT", String((opts && opts.creationTs) || 0));
    const bcs = proxy.toJs({ dict_converter: Object.fromEntries });
    proxy.destroy(); fn.destroy();
    return bcs;
  }

  return { generate, _encode };
});
