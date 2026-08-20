/*
 * Client-side carry-forward parser (browser).
 *
 * Reads last year's positions from either an eCH-0196 XML (exact) or a softax
 * "Wertschriften- und Guthabenverzeichnis" PDF (via pdf.js), so this year's
 * trades bind onto items already listed in the tax software. Port of
 * backend/carryforward.py. Exposed as window.SQCarry.
 */
(function (root, factory) {
  root.SQCarry = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const ISIN_RE = /[A-Z]{2}[A-Z0-9]{9}[0-9]/;

  function validIsin(isin) {
    if (!isin || isin.length !== 12 || !/^[A-Z]{2}[A-Z0-9]{9}[0-9]$/.test(isin)) return false;
    let digits = "";
    for (const c of isin) digits += (c >= "A" && c <= "Z") ? (c.charCodeAt(0) - 55) : c;
    let total = 0, dbl = false;
    for (let i = digits.length - 1; i >= 0; i--) {
      let n = +digits[i];
      if (dbl) { n *= 2; if (n > 9) n -= 9; }
      total += n; dbl = !dbl;
    }
    return total % 10 === 0;
  }

  function valorFromIsin(isin) {
    if (!isin || isin.length !== 12 || !isin.startsWith("CH")) return null;
    const d = isin.slice(2, 11);
    if (!/^\d{9}$/.test(d)) return null;
    const v = parseInt(d, 10);
    return v >= 100 && v <= 999999999999 ? v : null;
  }

  function num(s) {
    if (s == null) return null;
    const t = String(s).trim().replace(/[’'\s]/g, "");
    if (t === "" || t === "-") return null;
    const n = Number(t);
    return Number.isNaN(n) ? null : n;
  }

  // --- eCH-0196 XML -------------------------------------------------------
  function parseEchXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("XML konnte nicht gelesen werden.");
    const out = [];
    const secs = doc.getElementsByTagName("security");
    for (const sec of secs) {
      const isin = sec.getAttribute("isin") || "";
      const name = sec.getAttribute("securityName") || "";
      const valorAttr = sec.getAttribute("valorNumber");
      let qty = null;
      const tv = sec.getElementsByTagName("taxValue")[0];
      if (tv && tv.getAttribute("quantity") != null) qty = num(tv.getAttribute("quantity"));
      if (qty == null) {
        const balances = [...sec.getElementsByTagName("stock")].filter((s) => ["0", "false"].includes(s.getAttribute("mutation")));
        if (balances.length) qty = num(balances[balances.length - 1].getAttribute("quantity"));
      }
      out.push({ isin, name, valor: valorAttr ? parseInt(valorAttr, 10) : valorFromIsin(isin),
        quantity: qty != null ? String(qty) : "", source: "ech-xml" });
    }
    return out;
  }

  // --- softax Wertschriftenverzeichnis PDF --------------------------------
  function concatLine(toks) {
    // pdf.js text items on one line are already separate tokens, so a plain
    // space join is correct (no x-gap heuristic needed).
    return toks.sort((a, b) => a.x - b.x).map((t) => t.s).join(" ");
  }

  async function parseSoftaxPdf(arrayBuffer, pdfjsLib) {
    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    const out = [];
    const seen = new Set();
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // Build lines with x/x2 per token.
      const byY = new Map();
      for (const it of content.items) {
        if (!it.str || !it.str.trim()) continue;
        const x = it.transform[4], y = it.transform[5], w = it.width || 0;
        const key = Math.round(y);
        if (!byY.has(key)) byY.set(key, []);
        byY.get(key).push({ x, x2: x + w, s: it.str });
      }
      const lines = [...byY.entries()].sort((a, b) => b[0] - a[0]);
      // Segment into blocks by row markers (°/~ near the left margin).
      const blocks = [];
      let cur = null;
      for (const [, toks] of lines) {
        const sorted = toks.sort((a, b) => a.x - b.x);
        const first = sorted[0];
        // Row markers: "°" (no ISIN entered, e.g. accounts) or "**" (ISIN
        // present). Some softax versions may also use "~".
        const isMarker = first && first.x < 40 && /^[°~*]/.test(first.s);
        // pdf.js y grows upward; only consider data area (skip header legend)
        if (isMarker) { if (cur) blocks.push(cur); cur = [sorted]; }
        else if (cur) cur.push(sorted);
      }
      if (cur) blocks.push(cur);

      for (const blk of blocks) {
        const text = blk.map(concatLine).join(" ");
        const m = text.match(ISIN_RE);
        if (!m || !validIsin(m[0]) || seen.has(m[0])) continue;
        const isin = m[0];
        seen.add(isin);
        // Stückzahl: digit tokens in x 74..95 on the marker line.
        const digits = blk[0].filter((t) => t.x >= 74 && t.x <= 95 && /^\d$/.test(t.s))
          .sort((a, b) => a.x - b.x).map((t) => t.s).join("");
        const after = text.includes(isin + ",") ? text.split(isin + ",", 2)[1].trim() : "";
        const name = after.split(",")[0].trim();
        out.push({ isin, name, valor: valorFromIsin(isin), quantity: digits || "", source: "softax-pdf" });
      }
    }
    return out;
  }

  async function parse(arrayBuffer, filename, pdfjsLib) {
    const head = new Uint8Array(arrayBuffer.slice(0, 5)).reduce((s, b) => s + String.fromCharCode(b), "");
    const isPdf = head === "%PDF-" || /\.pdf$/i.test(filename || "");
    if (isPdf) return parseSoftaxPdf(arrayBuffer, pdfjsLib);
    const text = new TextDecoder("utf-8").decode(arrayBuffer);
    return parseEchXml(text);
  }

  return { parse, validIsin, valorFromIsin };
});
