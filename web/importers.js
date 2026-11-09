/*
 * Bank-agnostic import (browser + Node).
 *
 * Turns *any* bank's transaction export into the normalised transaction list
 * that core.js classifies. Three paths:
 *
 *   1. Swissquote CSV  – recognised automatically, parsed by SQCore.parseCsv.
 *   2. Any other CSV   – columns are auto-matched by header synonyms
 *                        (DE/EN/FR) and can be re-assigned by the user;
 *                        transaction types are mapped by keyword and can be
 *                        re-assigned too. A mapping can be saved as a local
 *                        "bank profile" and is re-applied when the same
 *                        header layout is seen again.
 *   3. Manual entry    – a small table for banks without any export.
 *
 * Output transaction shape (same as SQCore.parseCsv):
 *   { row, dateKey, date, type, symbol, name, isin, quantity, unitPrice,
 *     costs, net, currency }
 * where `type` is one of the canonical labels in TYPES below.
 *
 * Exposed as window.SQImport (browser) / module.exports (Node).
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SQImport = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Canonical transaction types understood by core.js.
  const TYPES = [
    { id: "Kauf", label: "Kauf / Zugang" },
    { id: "Verkauf", label: "Verkauf / Abgang" },
    { id: "Dividende", label: "Dividende / Ausschüttung / Coupon" },
    { id: "Zinsen auf Einlagen", label: "Zins auf Konto" },
    { id: "Bestand 01.01.", label: "Bestand 01.01. (Anfang)" },
    { id: "Bestand 31.12.", label: "Bestand 31.12. (Ende)" },
    { id: "Kontostand 31.12.", label: "Kontostand 31.12. (Cash)" },
    { id: "Depotgebühren", label: "Gebühr (nicht steuerrelevant)" },
    { id: "Zahlung", label: "Ein-/Auszahlung, Devisen (ignorieren)" },
    { id: "ignorieren", label: "Ignorieren" },
  ];
  const TYPE_IDS = new Set(TYPES.map((t) => t.id));

  // Target fields for column mapping.
  const FIELDS = [
    { id: "date", label: "Datum", required: true },
    { id: "type", label: "Transaktionsart" },
    { id: "isin", label: "ISIN" },
    { id: "name", label: "Titel / Bezeichnung" },
    { id: "symbol", label: "Symbol / Valor" },
    { id: "quantity", label: "Anzahl / Stück" },
    { id: "price", label: "Kurs / Stückpreis" },
    { id: "net", label: "Betrag (netto)" },
    { id: "costs", label: "Gebühren / Steuern" },
    { id: "currency", label: "Währung" },
  ];

  const SYNONYMS = {
    date: ["datum", "date", "buchungsdatum", "transaktionsdatum", "abschlussdatum", "handelsdatum",
      "tradedate", "valuta", "valutadatum", "bookingdate", "settlementdate", "ausfuhrungsdatum",
      "auftragsdatum", "dateoperation", "dateexecution", "datetime", "zeitpunkt"],
    type: ["transaktionen", "transaktion", "transaktionstyp", "transaktionsart", "typ", "art",
      "buchungsart", "buchungstext", "type", "transactiontype", "action", "operation", "auftragsart",
      "geschaftsart", "geschaeftsart", "activity", "category", "kategorie"],
    isin: ["isin", "isincode", "isinnummer", "wertpapierkennung", "securityid"],
    name: ["name", "titel", "bezeichnung", "wertpapier", "instrument", "description", "security",
      "titelbezeichnung", "produkt", "beschreibung", "securityname", "instrumentname", "libelle"],
    symbol: ["symbol", "ticker", "tickersymbol", "valor", "valorennummer", "valornummer", "wkn"],
    quantity: ["anzahl", "menge", "stuck", "stueck", "stuckzahl", "stueckzahl", "quantity", "qty",
      "shares", "nominal", "units", "quantite", "anzahlnominal"],
    price: ["kurs", "preis", "stuckpreis", "stueckpreis", "price", "tradeprice", "unitprice",
      "ausfuhrungskurs", "ausfuehrungskurs", "cours", "prix"],
    net: ["nettobetrag", "betrag", "netto", "amount", "netamount", "total", "buchungsbetrag",
      "proceeds", "gutschriftbelastung", "montant", "netcash", "endbetrag", "nettototal"],
    costs: ["kosten", "gebuhren", "gebuehren", "courtage", "commission", "fees", "fee", "steuern",
      "quellensteuer", "withholdingtax", "tax", "verrechnungssteuer", "ibcommission", "spesen", "frais"],
    currency: ["wahrung", "waehrung", "whg", "currency", "ccy", "devise", "currencyprimary", "monnaie"],
  };

  // ---- small helpers ------------------------------------------------------
  function norm(s) {
    return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "")
      .toLowerCase().replace(/[^a-z0-9]/g, "");
  }
  function words(s) {
    return String(s == null ? "" : s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  }
  const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

  function decodeBytes(buf) {
    const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    try { return new TextDecoder("utf-8", { fatal: true }).decode(u8).replace(/^﻿/, ""); }
    catch (e) { return new TextDecoder("windows-1252").decode(u8); }
  }

  function splitLine(line, delim) {
    const out = [];
    let cur = "", inq = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inq && line[i + 1] === '"') { cur += '"'; i++; } else inq = !inq;
      } else if (c === delim && !inq) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out.map((v) => v.trim());
  }

  // Read a delimited text file into { header, rows, delimiter }. Skips any
  // preamble lines banks put above the real header.
  function readTable(text) {
    const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
    if (!lines.length) throw new Error("Die Datei ist leer.");
    const probe = lines.slice(0, 40);
    let best = { delim: ";", score: -1 };
    for (const d of [";", ",", "\t", "|"]) {
      const counts = probe.map((l) => splitLine(l, d).length);
      const freq = {};
      counts.forEach((c) => { if (c > 1) freq[c] = (freq[c] || 0) + 1; });
      const mode = Object.entries(freq).sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
      const score = mode ? mode[1] * Math.min(+mode[0], 12) : 0;
      if (score > best.score) best = { delim: d, score, cols: mode ? +mode[0] : 0 };
    }
    if (best.cols < 2) throw new Error("Keine Tabellenstruktur erkannt (Trennzeichen ; , Tab).");
    const all = lines.map((l) => splitLine(l, best.delim));
    let h = all.findIndex((r) => r.length === best.cols && r.filter((c) => /[A-Za-zÄÖÜäöü]/.test(c)).length >= Math.min(2, best.cols));
    if (h < 0) h = 0;
    const header = all[h].map((c, i) => c || `Spalte ${i + 1}`);
    const rows = all.slice(h + 1).filter((r) => r.some((c) => c !== ""));
    return { header, rows, delimiter: best.delim };
  }

  function isSwissquote(header) {
    return header.includes("Transaktionen") && header.includes("Nettobetrag");
  }

  function signature(header) {
    return header.map(norm).join("|");
  }

  function guessMapping(header) {
    const n = header.map(norm);
    const mapping = {};
    const used = new Set();
    for (const f of FIELDS) {
      const syn = SYNONYMS[f.id];
      let idx = n.findIndex((h, i) => !used.has(i) && syn.includes(h));
      if (idx < 0) idx = n.findIndex((h, i) => !used.has(i) && h && syn.some((s) => s.length >= 4 && h.startsWith(s)));
      if (idx >= 0) { mapping[f.id] = idx; used.add(idx); }
    }
    return mapping;
  }

  // ---- numbers & dates ----------------------------------------------------
  function detectDecimal(values) {
    let comma = 0, dot = 0;
    for (const v of values) {
      const t = String(v || "").replace(/[\s'’  ]/g, "");
      if (/,\d{1,2}$/.test(t) || /\.\d{3},\d+$/.test(t)) comma++;
      if (/\.\d{1,2}$/.test(t) || /,\d{3}\.\d+$/.test(t)) dot++;
    }
    return comma > dot ? "," : ".";
  }

  function parseNumber(v, decimal) {
    if (v == null) return null;
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    let t = String(v).trim();
    if (!t || t === "-" || t === "--") return null;
    let neg = false;
    if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
    if (/-\s*$/.test(t) && !/^-/.test(t)) { neg = true; t = t.replace(/-\s*$/, ""); }
    if (/^\s*-/.test(t)) { neg = true; t = t.replace(/^\s*-/, ""); }
    t = t.replace(/[^\d.,]/g, "");
    if (!t) return null;
    if (decimal === ",") t = t.replace(/\./g, "").replace(",", ".");
    else t = t.replace(/,/g, "");
    const n = Number(t);
    if (Number.isNaN(n)) return null;
    return neg ? -n : n;
  }

  const MONTH_NAMES = { jan: 1, feb: 2, mar: 3, mrz: 3, maer: 3, apr: 4, mai: 5, may: 5, jun: 6, jul: 7,
    aug: 8, sep: 9, okt: 10, oct: 10, nov: 11, dez: 12, dec: 12, janv: 1, fev: 2, mars: 3, avr: 4,
    juin: 6, juil: 7, sept: 9, dic: 12 };

  function detectDateOrder(values) {
    for (const v of values) {
      const m = String(v || "").trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/);
      if (m) { if (+m[1] > 12) return "DMY"; if (+m[2] > 12) return "MDY"; }
    }
    return "DMY";
  }

  function parseDate(v, order) {
    const s = String(v || "").trim();
    if (!s) return null;
    let y, mo, d, m;
    if ((m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else if ((m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})/))) {
      y = +m[3]; if (y < 100) y += 2000;
      if (order === "MDY") { mo = +m[1]; d = +m[2]; } else { d = +m[1]; mo = +m[2]; }
    } else if ((m = words(s).match(/^(\d{1,2})\.?\s*([a-z]{3,5})\.?\s*(\d{4})/))) {
      d = +m[1]; mo = MONTH_NAMES[m[2]] || MONTH_NAMES[m[2].slice(0, 3)]; y = +m[3];
    } else if ((m = words(s).match(/^([a-z]{3,5})\.?\s*(\d{1,2}),?\s*(\d{4})/))) {
      mo = MONTH_NAMES[m[1]] || MONTH_NAMES[m[1].slice(0, 3)]; d = +m[2]; y = +m[3];
    } else return null;
    if (!y || !mo || !d || mo > 12 || d > 31) return null;
    const p = (n) => String(n).padStart(2, "0");
    return { iso: `${y}-${p(mo)}-${p(d)}`, key: y * 10000 + mo * 100 + d };
  }

  // ---- transaction types --------------------------------------------------
  function guessType(raw, hasIsin) {
    const w = words(raw);
    if (!w.trim()) return "";
    if (TYPE_IDS.has(String(raw).trim())) return String(raw).trim();
    if (/kontostand|saldo|balance/.test(w)) return "Kontostand 31.12.";
    if (/anfangsbestand|bestand 01|opening/.test(w)) return "Bestand 01.01.";
    if (/endbestand|bestand 31|closing|position/.test(w)) return "Bestand 31.12.";
    if (/dividend|ausschuttung|distribution|ertrag|coupon|kupon|capital gain|revenu/.test(w)) return "Dividende";
    if (/zins|interest|interet/.test(w)) return hasIsin ? "Dividende" : "Zinsen auf Einlagen";
    if (/verkauf|sell|sale|sold|vente|rucknahme|redemption|ruckzahlung|abgang/.test(w)) return "Verkauf";
    if (/kauf|buy|purchase|bought|achat|zeichnung|subscription|sparplan|zugang/.test(w)) return "Kauf";
    if (/gebuhr|fee|kommission|commission|custody|depot|spesen|frais|steuer|tax/.test(w)) return "Depotgebühren";
    if (/einzahlung|auszahlung|deposit|withdraw|uberweisung|transfer|zahlung|payment|forex|fx|devisen|wechsel|karte|card|virement/.test(w)) return "Zahlung";
    return "";
  }

  // Distinct raw type values with a suggested canonical type.
  function typeSuggestions(table, mapping) {
    const out = new Map();
    for (const r of table.rows) {
      const raw = mapping.type != null ? (r[mapping.type] || "") : "";
      const isin = mapping.isin != null ? String(r[mapping.isin] || "").toUpperCase() : "";
      const key = raw.trim();
      if (!out.has(key)) out.set(key, { raw: key, count: 0, suggestion: guessType(key, ISIN_RE.test(isin)) });
      out.get(key).count++;
    }
    return Array.from(out.values()).sort((a, b) => b.count - a.count);
  }

  // ---- normalisation ------------------------------------------------------
  // opts: { mapping, typeMap, decimal, dateOrder, defaultCurrency }
  function normalize(table, opts) {
    const mp = opts.mapping || {};
    const col = (r, f) => (mp[f] == null ? "" : (r[mp[f]] == null ? "" : String(r[mp[f]]).trim()));
    const numericCols = ["quantity", "price", "net", "costs"].filter((f) => mp[f] != null);
    const decimal = opts.decimal || detectDecimal(table.rows.flatMap((r) => numericCols.map((f) => col(r, f))));
    const dateOrder = opts.dateOrder || detectDateOrder(table.rows.map((r) => col(r, "date")));
    const typeMap = opts.typeMap || {};
    const txns = [], balances = [], skipped = [];

    table.rows.forEach((r, i) => {
      const d = parseDate(col(r, "date"), dateOrder);
      const rawType = col(r, "type");
      let isin = col(r, "isin").toUpperCase().replace(/\s/g, "");
      if (!ISIN_RE.test(isin)) isin = "";
      let qty = parseNumber(col(r, "quantity"), decimal);
      const net = parseNumber(col(r, "net"), decimal);
      let type = typeMap[rawType] != null ? typeMap[rawType] : guessType(rawType, !!isin);
      if (!type && qty != null && qty !== 0 && (isin || col(r, "name"))) type = qty > 0 ? "Kauf" : "Verkauf";
      if (!type || type === "ignorieren") { skipped.push({ line: i + 1, reason: type ? "ignoriert" : `Art unbekannt: '${rawType}'` }); return; }
      const currency = (col(r, "currency") || opts.defaultCurrency || "CHF").toUpperCase().slice(0, 3);
      if (type === "Kontostand 31.12.") {
        const amount = net != null ? net : qty;
        if (amount != null) balances.push({ currency, amount });
        return;
      }
      if (!d) { skipped.push({ line: i + 1, reason: "Datum fehlt/unlesbar" }); return; }
      if (qty != null && (type === "Kauf" || type === "Verkauf")) qty = Math.abs(qty);
      const costs = parseNumber(col(r, "costs"), decimal);
      txns.push({
        row: i + 1, dateKey: d.key, date: d.iso, type,
        symbol: col(r, "symbol"), name: col(r, "name") || col(r, "symbol") || isin,
        isin, quantity: qty, unitPrice: parseNumber(col(r, "price"), decimal),
        costs: costs != null ? Math.abs(costs) : null, net, currency,
      });
    });

    // core.js expects newest-first row numbering (Swissquote convention) when
    // breaking ties on the same day; flip if the file is oldest-first.
    if (txns.length > 1 && txns[0].dateKey < txns[txns.length - 1].dateKey) {
      const n = txns.length;
      txns.forEach((t, i) => { t.row = n - i; });
    }
    return { txns, balances, skipped, decimal, dateOrder };
  }

  // Manual entry rows: [{type,date,isin,name,quantity,net,costs,currency}]
  function fromManual(rows, defaultCurrency) {
    const header = ["type", "date", "isin", "name", "quantity", "net", "costs", "currency"];
    const table = { header, rows: rows.map((r) => header.map((h) => (r[h] == null ? "" : String(r[h])))) };
    const mapping = { type: 0, date: 1, isin: 2, name: 3, quantity: 4, net: 5, costs: 6, currency: 7 };
    const typeMap = {};
    rows.forEach((r) => { typeMap[r.type] = r.type; });
    return normalize(table, { mapping, typeMap, decimal: ".", dateOrder: "DMY", defaultCurrency });
  }

  // ---- saved bank profiles (per-browser convenience, localStorage) -------
  const PROFILE_KEY = "est-bank-profiles-v1";
  function loadProfiles() {
    try { return JSON.parse(localStorage.getItem(PROFILE_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveProfile(p) {
    try {
      const list = loadProfiles().filter((x) => x.signature !== p.signature);
      list.push(p);
      localStorage.setItem(PROFILE_KEY, JSON.stringify(list));
      return true;
    } catch (e) { return false; }
  }
  function findProfile(header) {
    const sig = signature(header);
    return loadProfiles().find((p) => p.signature === sig) || null;
  }

  return {
    TYPES, FIELDS, decodeBytes, readTable, isSwissquote, signature, guessMapping, guessType,
    typeSuggestions, normalize, fromManual, parseNumber, parseDate, detectDecimal,
    loadProfiles, saveProfile, findProfile,
  };
});
