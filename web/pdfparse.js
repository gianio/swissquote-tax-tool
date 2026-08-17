/*
 * Client-side Swissquote Kontoauszug PDF parser (browser, via pdf.js).
 *
 * A JS port of backend/pdf_parser.py: reads the column layout by text
 * coordinates and returns { transactions, balances, account }. Runs entirely
 * in the browser — the PDF is never uploaded anywhere.
 *
 * If a page has no text layer (a scanned statement), the caller can fall back
 * to OCR (see ocr.js); normal Swissquote downloads have a text layer and are
 * parsed exactly, which is more reliable than OCR.
 */
(function (root, factory) {
  root.SQPdf = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  function columnOf(x) {
    if (x < 74) return "date";
    if (x < 223) return "info";
    if (x < 276) return "ref";
    if (x < 345) return "belastung";
    if (x < 418) return "gutschrift";
    if (x < 505) return "valuta";
    return "saldo";
  }

  const DATE_RE = /^\d{2}\.\d{2}\.\d{4}$/;
  const SECTION_RE = /Kontoauszug in (\w{3})/;
  const ISIN_RE = /ISIN:\s*([A-Z0-9]{12})/;
  const SYMBOL_RE = /\(([^)]+)\)\s*$/;
  const CCY_RE = /^[A-Z]{3}$/;

  const TYPE_MAP = {
    "Kauf": "Kauf", "Verkauf": "Verkauf", "Dividende": "Dividende",
    "Kapitalgewinn": "Capital Gain", "Zahlung per Debitkarte": "Kartentransaktion",
    "Zahlung von": "Zahlung", "Depotgebühren": "Depotgebühren",
    "Börsengebühren": "Berichtigung Börsengeb.", "Kommission": "Berichtigung Börsengeb.",
    "Sollzinsen": "Berichtigung Börsengeb.", "Zinsen aus anderen Konten": "Zinsen auf Einlagen",
    "zu zahlende Optionsprämie": "Buy-to-Open", "Rückzahlung": "Rückzahlung",
  };
  const SKIP = new Set(["Anfangsbestand", "Schlussbilanz"]);

  function num(s) {
    if (s == null) return null;
    let t = String(s).trim().replace(/[’'\s]/g, "");
    if (t === "" || t === "-" || t === "--") return null;
    let n = Number(t);
    return Number.isNaN(n) ? null : n;
  }

  function parseDate(s) {
    const m = String(s || "").trim().match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) return null;
    return { iso: `${m[3]}-${m[2]}-${m[1]}`, key: +(m[3] + m[2] + m[1]) };
  }

  // Group a page's text items into visual lines (by rounded y), top-to-bottom.
  function pageLines(items) {
    const byY = new Map();
    for (const it of items) {
      const x = it.transform[4], y = it.transform[5];
      const key = Math.round(y);
      if (!byY.has(key)) byY.set(key, []);
      byY.get(key).push({ x, y, s: it.str });
    }
    // pdf.js y grows upward → sort descending for top-to-bottom reading order.
    return [...byY.entries()].sort((a, b) => b[0] - a[0]).map(([, toks]) => toks.sort((a, b) => a.x - b.x));
  }

  function colText(toks, col) {
    return toks.filter((t) => columnOf(t.x) === col).map((t) => t.s).join(" ").replace(/\s+/g, " ").trim();
  }

  function extractInfo(lines) {
    const out = { name: "", symbol: "", isin: "" };
    const labels = { "Anzahl": "anzahl", "Preis": "preis", "Betrag": "betrag",
      "Kommission": "kommission", "Taxen": "taxen", "Total": "total" };
    for (const line of lines) {
      let matched = false;
      for (const label in labels) {
        if (line.startsWith(label + ":")) {
          const rest = line.slice(label.length + 1).trim();
          const parts = rest.split(/\s+/);
          out[labels[label]] = parts.length ? num(parts[parts.length - 1]) : null;
          if (parts.length >= 2 && CCY_RE.test(parts[parts.length - 2]))
            out[labels[label] + "_ccy"] = parts[parts.length - 2];
          matched = true; break;
        }
      }
      if (matched) continue;
      const mi = line.match(ISIN_RE);
      if (mi) { out.isin = mi[1]; continue; }
      if (/^(Handelsplatz:|Referenz|Kurs:)/.test(line)) continue;
      if (!out.name) {
        const ms = line.match(SYMBOL_RE);
        if (ms) { out.symbol = ms[1]; out.name = line.slice(0, ms.index).trim(); }
        else if (line) out.name = line;
      }
    }
    return out;
  }

  function recordToTxn(rec) {
    const base = (rec.type || "").split("\n")[0].trim();
    if (!base || SKIP.has(base)) return null;
    const ccy = rec.ccy || "CHF";
    const bel = num(rec.belastung), gut = num(rec.gutschrift);
    const info = extractInfo(rec.infoLines);
    let mapped;
    if (base === "Automatisierter Währungstausch" || base === "Währungsumtausch")
      mapped = gut ? "Fx-Gutschrift Comp." : "Fx-Belastung Comp.";
    else if (base === "Kauf FOREX" || base === "Verkauf FOREX")
      mapped = gut ? "Forex-Gutschrift" : "Forex-Belastung";
    else mapped = TYPE_MAP[base] || base;

    const d = parseDate(rec.date);
    if (!d) return null;
    const net = gut != null ? gut : (bel != null ? -bel : null);
    let costs;
    if (mapped === "Dividende" || mapped === "Capital Gain") {
      const betrag = info.betrag, bccy = info.betrag_ccy;
      costs = (betrag != null && net != null && (bccy == null || bccy === ccy)) ? betrag - net : 0;
    } else {
      costs = (info.taxen || 0) + (info.kommission || 0);
    }
    return {
      row: 0, date: d.iso, dateKey: d.key, type: mapped,
      symbol: info.symbol || "", name: info.name || "", isin: info.isin || "",
      quantity: info.anzahl != null ? info.anzahl : null,
      unitPrice: info.preis != null ? info.preis : null,
      costs, net, currency: ccy,
    };
  }

  function backfillIsins(txns) {
    const bySym = {}, byName = {};
    for (const t of txns) if (t.isin) {
      if (t.symbol && !(t.symbol in bySym)) bySym[t.symbol] = t.isin;
      if (t.name && !(t.name.toUpperCase() in byName)) byName[t.name.toUpperCase()] = t.isin;
    }
    for (const t of txns) if (!t.isin) t.isin = bySym[t.symbol] || byName[(t.name || "").toUpperCase()] || "";
  }

  function parseIdentity(text) {
    const acc = { holderName: "", iban: "", customerNumber: "" };
    let m = text.match(/(?:Herrn|Frau|Herr)\s+([^\n]+)/); if (m) acc.holderName = m[1].trim();
    m = text.match(/IBAN[^\n]*\n\s*([A-Z]{2}[0-9 ]{15,34})/); if (m) acc.iban = m[1].replace(/\s+/g, "");
    m = text.match(/Kunde\s*\n?\s*(\d{4,})/); if (m) acc.customerNumber = m[1];
    return acc;
  }

  function parseBalances(text) {
    const out = [];
    // pdf.js emits each token on its own line, so normalise whitespace before
    // locating the "…aufgeteilt auf alle Währungen" block.
    const KNOWN = new Set(["CHF", "EUR", "USD", "GBP", "CAD", "DKK", "SEK", "NOK",
      "JPY", "AUD", "NZD", "SGD", "HKD", "XAU", "XAG", "XPT", "XPD"]);
    const flat = text.replace(/\s+/g, " ");
    const parts = flat.split(/aufgeteilt auf alle/);   // ü-free anchor for robustness
    if (parts.length < 2) return out;
    // The balance block is short; bound the scan so we don't pick up amounts
    // from the transaction pages that follow.
    const block = parts[1].slice(0, 400);
    const seen = new Set();
    const re = /(-?[\d'’]+(?:\.\d+)?)\s+([A-Z]{3})/g;
    let m;
    while ((m = re.exec(block))) {
      const a = num(m[1]);
      if (a == null || !KNOWN.has(m[2]) || seen.has(m[2])) continue;
      seen.add(m[2]);
      out.push({ currency: m[2], amount: a });
    }
    return out;
  }

  async function parseKontoauszug(arrayBuffer, pdfjsLib) {
    const doc = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
    let fullText = "";
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items = content.items.filter((i) => i.str && i.str.trim() !== "");
      pages.push(items);
      fullText += items.map((i) => i.str).join("\n") + "\n";
    }
    // A scanned/photographed statement has (almost) no text layer. Coordinate
    // parsing needs the text layer; OCR can't recover the column structure
    // reliably, so we ask for the original digital PDF instead of guessing.
    if (fullText.trim().length < 200)
      throw new Error("Dieses PDF enthält keine Textebene (evtl. gescannt/fotografiert). "
        + "Bitte das digitale Original‑Kontoauszug‑PDF aus Swissquote verwenden.");
    if (!/Kontoauszug/.test(fullText) || !/Swissquote/.test(fullText))
      throw new Error("Das sieht nicht nach einem Swissquote-Kontoauszug-PDF aus.");

    const account = parseIdentity(fullText);
    const balances = parseBalances(fullText);

    const raw = [];
    let ccy = null, pending = null;
    const finalise = () => { if (pending) { const t = recordToTxn(pending); if (t) raw.push(t); } };
    for (const items of pages) {
      const pageText = items.map((i) => i.str).join(" ");
      const sm = pageText.match(SECTION_RE);
      if (sm) { finalise(); pending = null; ccy = sm[1]; }
      for (const toks of pageLines(items)) {
        const dateText = colText(toks, "date");
        const infoText = colText(toks, "info");
        if (DATE_RE.test(dateText)) {
          finalise();
          pending = { ccy, date: dateText, type: infoText, belastung: colText(toks, "belastung"),
            gutschrift: colText(toks, "gutschrift"), infoLines: [] };
        } else if (pending) {
          if (infoText) pending.infoLines.push(infoText);
          for (const k of ["belastung", "gutschrift"]) {
            const v = colText(toks, k);
            if (v && !pending[k]) pending[k] = v;
          }
        }
      }
    }
    finalise();
    backfillIsins(raw);
    raw.reverse();
    raw.forEach((t, i) => (t.row = i + 1));
    if (!raw.length) throw new Error("Keine Transaktionen im PDF gefunden.");
    return { transactions: raw, balances, account, hasTextLayer: fullText.trim().length > 200 };
  }

  return { parseKontoauszug, columnOf };
});
