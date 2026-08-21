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
  // Wegleitung", matched exactly to the server's opensteuerauszug/reportlab
  // renderer (confirmed against a real generated statement): landscape A4,
  // barcodes rotated 90° and laid out 6-per-page in a single row, module
  // size 0.42mm (per original column) x 0.4mm-per-pixel-row (x2 ratio =
  // 0.8mm per PDF417 row). Each barcode is embedded as a rotated raster PNG
  // image — not drawn as vector rectangles — because that's what the
  // reference PDF does (pdf417gen.render_image -> PIL rotate(-90) -> PNG ->
  // reportlab Image flowable), and softax's importer may specifically look
  // for embedded barcode images rather than rasterising the whole page.
  const MM = 2.834645669291339; // pt per mm
  const PAGE_W_MM = 297, PAGE_H_MM = 210; // landscape A4
  const MARGIN_LEFT_MM = 24, MARGIN_RIGHT_MM = 13, MARGIN_TOP_MM = 40, MARGIN_BOTTOM_MM = 18;
  const MODULE_COL_MM = 0.42;      // per original column -> final rotated height
  const MODULE_ROW_PIXEL_MM = 0.4; // per pixel-row; x RATIO -> final rotated width
  const RATIO = 2;
  const BARCODES_PER_ROW = 6;

  // Render one barcode's modules to a rotated (90°) raster PNG, matching
  // pdf417gen.render_image(scale=1, ratio=2) + PIL rotate(-90, expand=True):
  // pre-rotation image is (w x h*ratio); rotated image is (h*ratio x w).
  function moduleCanvasPng(bc) {
    return new Promise((resolve, reject) => {
      const preH = bc.h * RATIO;
      const canvas = document.createElement("canvas");
      canvas.width = preH;   // post-rotation width
      canvas.height = bc.w;  // post-rotation height
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = "#000";
      for (let r = 0; r < bc.rows.length; r++) {
        for (const [start, len] of runs(bc.rows[r])) {
          ctx.fillRect(preH - (r + 1) * RATIO, start, RATIO, len);
        }
      }
      canvas.toBlob((blob) => {
        if (!blob) { reject(new Error("Barcode-Rasterung fehlgeschlagen.")); return; }
        blob.arrayBuffer().then((buf) => resolve(new Uint8Array(buf))).catch(reject);
      }, "image/png");
    });
  }

  // --- 1D "page identifier" barcode (Code128, subset C) -------------------
  //
  // Required by "Beilage zu eCH-0196 V2.2.0 – Barcode Generierung –
  // Technische Wegleitung" on every barcode page, independent of the 2D
  // macro-PDF417 payload — softax's importer likely uses this to recognise
  // a page as an eCH-0196 barcode sheet in the first place. Ported from
  // opensteuerauszug's OneDeeBarCode (render/onedee.py), which in turn uses
  // reportlab's Code128 encoder — the pattern table below is copied from
  // reportlab/graphics/barcode/code128.py so the encoding matches exactly
  // (standard ISO/IEC 15417 Code128 symbol table; letter-encoded widths,
  // uppercase = bar, lowercase = space, A=1..D=4 units).
  const CODE128_PATTERNS = {
    0: 'BaBbBb', 1: 'BbBaBb', 2: 'BbBbBa', 3: 'AbAbBc', 4: 'AbAcBb', 5: 'AcAbBb',
    6: 'AbBbAc', 7: 'AbBcAb', 8: 'AcBbAb', 9: 'BbAbAc', 10: 'BbAcAb', 11: 'BcAbAb',
    12: 'AaBbCb', 13: 'AbBaCb', 14: 'AbBbCa', 15: 'AaCbBb', 16: 'AbCaBb', 17: 'AbCbBa',
    18: 'BbCbAa', 19: 'BbAaCb', 20: 'BbAbCa', 21: 'BaCbAb', 22: 'BbCaAb', 23: 'CaBaCa',
    24: 'CaAbBb', 25: 'CbAaBb', 26: 'CbAbBa', 27: 'CaBbAb', 28: 'CbBaAb', 29: 'CbBbAa',
    30: 'BaBaBc', 31: 'BaBcBa', 32: 'BcBaBa', 33: 'AaAcBc', 34: 'AcAaBc', 35: 'AcAcBa',
    36: 'AaBcAc', 37: 'AcBaAc', 38: 'AcBcAa', 39: 'BaAcAc', 40: 'BcAaAc', 41: 'BcAcAa',
    42: 'AaBaCc', 43: 'AaBcCa', 44: 'AcBaCa', 45: 'AaCaBc', 46: 'AaCcBa', 47: 'AcCaBa',
    48: 'CaCaBa', 49: 'BaAcCa', 50: 'BcAaCa', 51: 'BaCaAc', 52: 'BaCcAa', 53: 'BaCaCa',
    54: 'CaAaBc', 55: 'CaAcBa', 56: 'CcAaBa', 57: 'CaBaAc', 58: 'CaBcAa', 59: 'CcBaAa',
    60: 'CaDaAa', 61: 'BbAdAa', 62: 'DcAaAa', 63: 'AaAbBd', 64: 'AaAdBb', 65: 'AbAaBd',
    66: 'AbAdBa', 67: 'AdAaBb', 68: 'AdAbBa', 69: 'AaBbAd', 70: 'AaBdAb', 71: 'AbBaAd',
    72: 'AbBdAa', 73: 'AdBaAb', 74: 'AdBbAa', 75: 'BdAbAa', 76: 'BbAaAd', 77: 'DaCaAa',
    78: 'BdAaAb', 79: 'AcDaAa', 80: 'AaAbDb', 81: 'AbAaDb', 82: 'AbAbDa', 83: 'AaDbAb',
    84: 'AbDaAb', 85: 'AbDbAa', 86: 'DaAbAb', 87: 'DbAaAb', 88: 'DbAbAa', 89: 'BaBaDa',
    90: 'BaDaBa', 91: 'DaBaBa', 92: 'AaAaDc', 93: 'AaAcDa', 94: 'AcAaDa', 95: 'AaDaAc',
    96: 'AaDcAa', 97: 'DaAaAc', 98: 'DaAcAa', 99: 'AaCaDa', 100: 'AaDaCa', 101: 'CaAaDa',
    102: 'DaAaCa', 103: 'BaAdAb', 104: 'BaAbAd', 105: 'BaAbCb', 106: 'BcCaAaB',
  };
  const CODE128_START_C = 105, CODE128_STOP = 106;

  // [[isBar, widthUnits], ...] for an even-length numeric string (subset C:
  // one symbol per digit pair).
  function code128CElements(digits) {
    if (digits.length % 2 !== 0 || !/^\d+$/.test(digits)) {
      throw new Error("Code128-C benötigt eine gerade Anzahl Ziffern.");
    }
    const values = [CODE128_START_C];
    for (let i = 0; i < digits.length; i += 2) values.push(parseInt(digits.slice(i, i + 2), 10));
    let checksum = values[0];
    for (let i = 1; i < values.length; i++) checksum += values[i] * i;
    values.push(checksum % 103, CODE128_STOP);
    const decomposed = values.map((v) => CODE128_PATTERNS[v]).join("");
    return [...decomposed].map((ch) => [ch === ch.toUpperCase(), ch.toUpperCase().charCodeAt(0) - 64]);
  }

  // Draws the page-identifier barcode, rotated 90°, per onedee.py's
  // draw_barcode_on_canvas: 0.3mm module width, >=7mm bar height, both x a
  // 1/0.97 print-scale correction; positioned so the top of the (rotated)
  // barcode sits 10mm from the page top and the human-readable text
  // baseline sits 5mm from the left edge.
  function drawPageIdentifierBarcode(page, font, opts) {
    const { orgNr, pageNumber, isBarcodePage, pageHeightPt } = opts;
    const PRINT_SCALE = 1 / 0.97;
    const barWidthPt = 0.3 * MM * PRINT_SCALE;
    const barHeightPt = 7 * MM * PRINT_SCALE;
    const marginTopPt = 10 * MM;
    const marginLeftPt = 5 * MM * PRINT_SCALE;
    const textGapPt = 5 * MM * PRINT_SCALE;

    const data = "196" + "22" + orgNr + String(pageNumber).padStart(3, "0") + (isBarcodePage ? "1" : "0") + "02";
    const elements = code128CElements(data);

    const finalBlX = marginLeftPt + textGapPt;
    const finalBlY = pageHeightPt - marginTopPt;
    const black = PDFLib.rgb(0, 0, 0);

    let left = 0;
    for (const [isBar, units] of elements) {
      const w = units * barWidthPt;
      if (isBar) {
        page.drawRectangle({
          x: finalBlX, width: barHeightPt,
          y: finalBlY - (left + w), height: w,
          color: black,
        });
      }
      left += w;
    }
    const totalWidth = left;
    const textSize = 9;
    const textWidth = font.widthOfTextAtSize(data, textSize);
    page.drawText(data, {
      x: marginLeftPt, y: finalBlY - totalWidth / 2 - textWidth / 2,
      size: textSize, font, color: black, rotate: PDFLib.degrees(90),
    });
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

    const PAGE_W = PAGE_W_MM * MM, PAGE_H = PAGE_H_MM * MM;
    const ML = MARGIN_LEFT_MM * MM, MR = MARGIN_RIGHT_MM * MM;
    const MT = MARGIN_TOP_MM * MM, MB = MARGIN_BOTTOM_MM * MM;
    const usableWidth = PAGE_W - ML - MR;
    const colWidth = usableWidth / BARCODES_PER_ROW;
    const rowWidthPt = RATIO * MODULE_ROW_PIXEL_MM * MM;  // per PDF417 row, after rotation
    const colHeightPt = MODULE_COL_MM * MM;                // per original column, after rotation

    const pageCount = Math.max(1, Math.ceil(barcodes.length / BARCODES_PER_ROW));
    const orgNrRaw = String(opts.statementId || "").slice(2, 7);
    const orgNr = /^\d{5}$/.test(orgNrRaw) ? orgNrRaw : "00000";
    let page = null;
    const newPage = (pageNum) => {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      page.drawText("Swissquote - eCH-0196 E-Steuerauszug", { x: ML, y: PAGE_H - MT + 20, size: 12, font: fontB });
      page.drawText(
        `Steuerjahr ${opts.taxYear || ""} - Barcode (macro PDF417) - nicht bank-signiert - Seite ${pageNum + 1} / ${pageCount}`,
        { x: ML, y: PAGE_H - MT + 6, size: 8, font, color: rgb(0.3, 0.3, 0.3) }
      );
      drawPageIdentifierBarcode(page, font, {
        orgNr, pageNumber: pageNum + 1, isBarcodePage: true, pageHeightPt: PAGE_H,
      });
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

      const pngBytes = await moduleCanvasPng(bc);
      const pngImage = await pdf.embedPng(pngBytes);
      page.drawImage(pngImage, { x: originX, y: originY, width: rotatedWidth, height: rotatedHeight });
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
