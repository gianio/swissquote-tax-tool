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

    const PAGE_W = 595.28, PAGE_H = 841.89, MARGIN = 40;
    const MW = 1.6, RATIO = 2, MH = MW * RATIO;       // module width / height (pt)
    const GAP = 26;                                    // vertical gap between barcodes
    const black = rgb(0, 0, 0);

    let page = null, y = 0;
    const newPage = () => {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      page.drawText("Swissquote - eCH-0196 E-Steuerauszug", { x: MARGIN, y: PAGE_H - MARGIN, size: 12, font: fontB });
      page.drawText("Steuerjahr " + (opts.taxYear || "") + " - Barcode (macro PDF417) - nicht bank-signiert",
        { x: MARGIN, y: PAGE_H - MARGIN - 14, size: 8, font, color: rgb(0.3, 0.3, 0.3) });
      y = PAGE_H - MARGIN - 40;
    };
    newPage();

    for (let bi = 0; bi < barcodes.length; bi++) {
      const bc = barcodes[bi];
      const bw = bc.w * MW, bh = bc.h * MH;
      if (y - bh - 16 < MARGIN) newPage();
      page.drawText(`Barcode ${bi + 1} / ${barcodes.length}`, { x: MARGIN, y: y - 9, size: 8, font, color: rgb(0.4, 0.4, 0.4) });
      const top = y - 14;
      for (let r = 0; r < bc.rows.length; r++) {
        const yy = top - r * MH;
        for (const [start, len] of runs(bc.rows[r])) {
          page.drawRectangle({ x: MARGIN + start * MW, y: yy - MH, width: len * MW, height: MH, color: black });
        }
      }
      y = top - bh - GAP;
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
