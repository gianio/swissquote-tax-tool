/*
 * Browser-only core: Swissquote CSV -> eCH-0196 XML, with NO server.
 *
 * This is a JavaScript port of the Python pipeline (csv_parser + classifier +
 * statement_builder) proving that the whole conversion can run client-side.
 * The same file is loadable in Node (module.exports) for XSD validation tests
 * and in the browser (window.SQCore) for the app.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.SQCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---- number helpers -----------------------------------------------------
  function money(x) { return Math.round(Number(x) * 100) / 100; }
  function fmt(x) {
    if (x === null || x === undefined) return null;
    let r = Math.round(Number(x) * 1e8) / 1e8;
    let s = r.toFixed(8).replace(/\.?0+$/, "");
    return s === "" || s === "-0" ? "0" : s;
  }
  function parseNum(v) {
    if (v == null) return null;
    let t = String(v).trim().replace(/['’\s]/g, "");
    if (t === "" || t === "-" || t === "--") return null;
    let n = Number(t);
    return Number.isNaN(n) ? null : n;
  }
  function xmlEsc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c];
    });
  }

  // ---- CSV parsing --------------------------------------------------------
  function splitCsvLine(line, delim) {
    const out = [];
    let cur = "", inq = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inq && line[i + 1] === '"') { cur += '"'; i++; }
        else inq = !inq;
      } else if (c === delim && !inq) { out.push(cur); cur = ""; }
      else cur += c;
    }
    out.push(cur);
    return out;
  }

  function parseDate(s) {
    // "31-12-2025 12:08:52" -> {iso:"2025-12-31", key:20251231}
    const datePart = String(s || "").trim().split(" ")[0];
    let m = datePart.match(/^(\d{2})[-.](\d{2})[-.](\d{4})$/);
    if (m) return { iso: `${m[3]}-${m[2]}-${m[1]}`, key: +(m[3] + m[2] + m[1]) };
    m = datePart.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (m) return { iso: datePart, key: +(m[1] + m[2] + m[3]) };
    return null;
  }

  function parseCsv(text) {
    const rows = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "");
    if (!rows.length) throw new Error("Die Datei ist leer.");
    const sample = rows[0];
    const delim = (sample.split(";").length >= sample.split(",").length) ? ";" : ",";
    const header = splitCsvLine(rows[0], delim).map((h) => h.trim().replace(/^﻿/, ""));
    if (!header.includes("Transaktionen"))
      throw new Error("Das sieht nicht nach einem Swissquote-Transaktionsexport aus.");
    const idx = {};
    header.forEach((h, i) => (idx[h] = i));
    const cell = (arr, name) => { const i = idx[name]; return i == null || i >= arr.length ? "" : arr[i].trim(); };

    const txns = [];
    for (let r = 1; r < rows.length; r++) {
      const arr = splitCsvLine(rows[r], delim);
      const d = parseDate(cell(arr, "Datum"));
      if (!d) continue;
      txns.push({
        row: r,
        dateKey: d.key,
        date: d.iso,
        type: cell(arr, "Transaktionen"),
        symbol: cell(arr, "Symbol"),
        name: cell(arr, "Name"),
        isin: cell(arr, "ISIN"),
        quantity: parseNum(cell(arr, "Anzahl")),
        unitPrice: parseNum(cell(arr, "Stückpreis")) ?? parseNum(cell(arr, "Stückpreis")),
        costs: parseNum(cell(arr, "Kosten")),
        net: parseNum(cell(arr, "Nettobetrag")),
        currency: cell(arr, "Währung") || cell(arr, "Währung"),
      });
    }
    if (!txns.length) throw new Error("Keine Transaktionen gefunden.");
    return txns;
  }

  // ---- classification -----------------------------------------------------
  const BUY = new Set(["Kauf", "Buy-to-Open"]);
  const SELL = new Set(["Verkauf"]);
  const INCOME = new Set(["Dividende", "Capital Gain"]);
  const INTEREST = new Set(["Zinsen auf Einlagen"]);
  const CORP = new Set(["Titelumbuchung", "Ausübung von Anrechten", "Ausgabe von Anrechten",
    "Ausübung", "Expiration", "Rückzahlung"]);
  const CASH = new Set(["Kartentransaktion", "Fx-Gutschrift Comp.", "Fx-Belastung Comp.",
    "Forex-Gutschrift", "Forex-Belastung", "Zahlung"]);
  const CCY_COUNTRY = { CHF: "CH", USD: "US", CAD: "CA", DKK: "DK", XAU: "XX", EUR: "XX", GBP: "GB" };
  const REAL_ISIN = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

  function grossFrom(t) {
    if (t.net == null) {
      if (t.quantity != null && t.unitPrice != null) return Math.abs(t.quantity * t.unitPrice);
      return null;
    }
    return Math.abs(t.net) + (t.costs || 0);
  }

  function classifyInstrument(t) {
    const isin = (t.isin || "").trim();
    if (/^EX0X00/.test(isin)) return { isin: null, category: "OTHER", type: "crypto" };
    if (/^(SQ|XB)/.test(isin)) return { isin: null, category: "OPTION", type: "option" };
    if (REAL_ISIN.test(isin)) {
      const n = (t.name || "").toUpperCase();
      const fund = ["ETF", "FUND", "UCITS", "ISH", "UBSETF", "VANGUARD", "ISHARES"].some((k) => n.includes(k));
      return { isin, category: fund ? "FUND" : "SHARE", type: null };
    }
    return { isin: null, category: "OTHER", type: null };
  }

  function classify(txns, defaultCountry) {
    defaultCountry = defaultCountry || "CH";
    const instruments = new Map();
    const cashInterest = [];
    const warnings = [];

    function getInst(t) {
      const ci = classifyInstrument(t);
      const key = ci.isin ? "isin:" + ci.isin : (t.symbol ? "sym:" + t.symbol : "name:" + t.name);
      let inst = instruments.get(key);
      if (!inst) {
        const country = ci.isin ? ci.isin.slice(0, 2) : (CCY_COUNTRY[t.currency] || defaultCountry);
        inst = {
          key, symbol: t.symbol, name: t.name || t.symbol || ci.isin || "Unknown",
          isin: ci.isin, currency: t.currency, country, category: ci.category, secType: ci.type,
          movements: [], income: [], corp: [],
          openingQty: 0, closingQty: 0, openingInferred: false,
        };
        instruments.set(key, inst);
      }
      return inst;
    }

    for (const t of txns) {
      const ty = t.type;
      if (INTEREST.has(ty)) {
        cashInterest.push({ date: t.date, gross: grossFrom(t) || 0, tax: t.costs || 0, net: t.net || 0, currency: t.currency });
        continue;
      }
      if (ty === "Depotgebühren" || ty === "Berichtigung Börsengeb." || CASH.has(ty)) continue;
      if (INCOME.has(ty)) {
        const inst = getInst(t);
        inst.income.push({ date: t.date, type: ty, gross: grossFrom(t) || 0, tax: t.costs || 0, net: t.net || 0, currency: t.currency, row: t.row });
        continue;
      }
      if (BUY.has(ty) || SELL.has(ty)) {
        const inst = getInst(t);
        const qty = t.quantity || 0;
        const signed = BUY.has(ty) ? qty : -qty;
        inst.movements.push({ date: t.date, dateKey: t.dateKey, row: t.row, type: ty, qty: signed,
          unitPrice: t.unitPrice, gross: grossFrom(t), currency: t.currency });
        continue;
      }
      if (CORP.has(ty)) {
        const inst = getInst(t);
        const qty = t.quantity || 0;
        inst.corp.push({ date: t.date, dateKey: t.dateKey, row: t.row, type: ty, qty,
          unitPrice: t.unitPrice, gross: grossFrom(t), currency: t.currency });
        if (ty === "Rückzahlung" && t.net && t.net > 0)
          inst.income.push({ date: t.date, type: ty, gross: grossFrom(t) || 0, tax: t.costs || 0, net: t.net, currency: t.currency, row: t.row });
        continue;
      }
      warnings.push(`Unbekannter Typ '${ty}' (Zeile ${t.row}) ignoriert.`);
    }

    // Position reconstruction (chronological: date asc, row desc -> CSV newest-first).
    for (const inst of instruments.values()) {
      const events = inst.movements.concat(inst.corp)
        .sort((a, b) => (a.dateKey - b.dateKey) || (b.row - a.row));
      let running = 0, minRun = 0;
      for (const e of events) { running += e.qty; if (running < minRun) minRun = running; }
      inst.openingQty = minRun < 0 ? -minRun : 0;
      inst.openingInferred = inst.openingQty > 0;
      inst.closingQty = inst.openingQty + running;
    }
    return { instruments: Array.from(instruments.values()), cashInterest, warnings };
  }

  // ---- valor from Swiss ISIN ---------------------------------------------
  function valorFromIsin(isin) {
    if (!isin || isin.length !== 12 || !isin.startsWith("CH")) return null;
    const digits = isin.slice(2, 11);
    if (!/^\d{9}$/.test(digits)) return null;
    const v = parseInt(digits, 10);
    return v >= 100 && v <= 999999999999 ? v : null;
  }

  function chronological(list) {
    return list.slice().sort((a, b) => (a.dateKey - b.dateKey) || (b.row - a.row));
  }

  // ---- eCH-0196 XML builder ----------------------------------------------
  function buildXml(result, cfg) {
    const rate = (c) => (cfg.fxRates && cfg.fxRates[c] != null ? Number(cfg.fxRates[c]) : (c === "CHF" ? 1 : 1));
    const periodFrom = `${cfg.taxYear}-01-01`;
    const periodTo = `${cfg.taxYear}-12-31`;
    const minimal = cfg.taxValueMode !== "estimate";

    let totTax = 0, totA = 0, totB = 0, totWht = 0;
    const secXml = [];
    let posId = 1;

    for (const inst of result.instruments) {
      if (inst.secType === "option" && cfg.includeOptions === false) continue;
      if (inst.secType === "crypto" && cfg.includeCrypto === false) continue;
      const r = rate(inst.currency);
      const attrs = [
        `positionId="${posId}"`,
        `country="${xmlEsc(inst.country)}"`,
        `currency="${xmlEsc(inst.currency)}"`,
        `quotationType="PIECE"`,
        `securityCategory="${inst.category}"`,
        `securityName="${xmlEsc((inst.name || "Unknown").slice(0, 60))}"`,
      ];
      if (inst.isin) attrs.push(`isin="${inst.isin}"`);
      const valor = valorFromIsin(inst.isin);
      if (valor != null) attrs.push(`valorNumber="${valor}"`);

      const children = [];

      // taxValue (minimal: undefined + kursliste; estimate: last price * fx)
      let secTax = 0;
      if (inst.closingQty !== 0) {
        if (minimal) {
          children.push(`      <taxValue referenceDate="${periodTo}" quotationType="PIECE" quantity="${fmt(inst.closingQty)}" balanceCurrency="${inst.currency}" undefined="1" kursliste="1"/>`);
        } else {
          let last = null;
          for (const m of chronological(inst.movements).reverse()) { if (m.unitPrice && m.unitPrice > 0) { last = m.unitPrice; break; } }
          const val = last != null ? money(inst.closingQty * last * r) : 0;
          secTax = val;
          children.push(`      <taxValue referenceDate="${periodTo}" quotationType="PIECE" quantity="${fmt(inst.closingQty)}" balanceCurrency="${inst.currency}"${last != null ? ` unitPrice="${fmt(last)}" balance="${fmt(money(inst.closingQty * last))}" exchangeRate="${fmt(r)}" value="${fmt(val)}"` : ""} kursliste="1"/>`);
        }
      }

      // payments (income)
      const isSwiss = inst.country === "CH";
      for (const inc of inst.income.slice().sort((a, b) => a.row - b.row === 0 ? 0 : b.row - a.row)) {
        const grossChf = money(inc.gross * r), taxChf = money(inc.tax * r);
        let rev = "";
        if (isSwiss) { rev = ` grossRevenueA="${fmt(grossChf)}" withHoldingTaxClaim="${fmt(taxChf)}"`; totA += grossChf; totWht += taxChf; }
        else { rev = ` grossRevenueB="${fmt(grossChf)}"`; totB += grossChf; }
        children.push(`      <payment paymentDate="${inc.date}" quotationType="PIECE" quantity="1" amountCurrency="${inc.currency}" amountPerUnit="${fmt(money(inc.gross))}" amount="${fmt(money(inc.gross))}" exchangeRate="${fmt(r)}" name="${xmlEsc(inc.type)}"${rev}/>`);
      }

      // stock: opening balance, movements, closing balance
      children.push(`      <stock referenceDate="${periodFrom}" mutation="0" quotationType="PIECE" quantity="${fmt(inst.openingQty)}" balanceCurrency="${inst.currency}" name="Bestand 01.01.${inst.openingInferred ? " (rekonstruiert)" : ""}"/>`);
      for (const m of chronological(inst.movements.concat(inst.corp))) {
        const up = m.unitPrice && m.unitPrice > 0 ? ` unitPrice="${fmt(m.unitPrice)}"` : "";
        const bal = m.gross != null ? ` balance="${fmt(money(m.gross))}"` : "";
        children.push(`      <stock referenceDate="${m.date}" mutation="1" quotationType="PIECE" quantity="${fmt(m.qty)}" balanceCurrency="${inst.currency}"${up}${bal} name="${xmlEsc(m.type)}"/>`);
      }
      children.push(`      <stock referenceDate="${periodTo}" mutation="0" quotationType="PIECE" quantity="${fmt(inst.closingQty)}" balanceCurrency="${inst.currency}" name="Bestand 31.12."/>`);

      totTax += secTax;
      secXml.push(`    <security ${attrs.join(" ")}>\n${children.join("\n")}\n    </security>`);
      posId++;
    }

    const secTotalsA = totA, secTotalsB = totB, secTotalsWht = totWht, secTotalsTax = totTax;

    // Bank accounts: interest (revenue A) + optional cash balances (tax value).
    let bankXml = "", bankInterest = 0, cashTax = 0;
    const byCcy = {};
    for (const inc of result.cashInterest) (byCcy[inc.currency] = byCcy[inc.currency] || []).push(inc);
    const balByCcy = {};
    for (const b of (cfg.cashBalances || [])) if (b.currency !== "XAU") balByCcy[b.currency] = b.amount;
    const ccys = Array.from(new Set(Object.keys(byCcy).concat(Object.keys(balByCcy)))).sort();
    if (ccys.length) {
      const accts = [];
      for (const c of ccys) {
        const r = rate(c);
        const pays = [];
        let aGross = 0;
        for (const inc of (byCcy[c] || [])) {
          const g = money(inc.gross * r); aGross += g;
          pays.push(`      <payment paymentDate="${inc.date}" name="Zinsen auf Einlagen" amountCurrency="${c}" amount="${fmt(money(inc.gross))}" exchangeRate="${fmt(r)}" grossRevenueA="${fmt(g)}" grossRevenueB="0" withHoldingTaxClaim="0"/>`);
        }
        bankInterest += aGross;
        let tv = "", accTax = 0;
        if (balByCcy[c] != null) {
          accTax = money(balByCcy[c] * r); cashTax += accTax;
          tv = `      <taxValue referenceDate="${periodTo}" balanceCurrency="${c}" balance="${fmt(money(balByCcy[c]))}" exchangeRate="${fmt(r)}" value="${fmt(accTax)}" name="Saldo ${c} 31.12."/>\n`;
        }
        accts.push(`    <bankAccount bankAccountName="Swissquote ${c}" bankAccountCurrency="${c}" bankAccountCountry="CH" totalTaxValue="${fmt(accTax)}" totalGrossRevenueA="${fmt(aGross)}" totalGrossRevenueB="0" totalWithHoldingTaxClaim="0">\n${tv}${pays.join("\n")}${pays.length ? "\n" : ""}    </bankAccount>`);
      }
      totA += bankInterest; totTax += cashTax;
      bankXml = `  <listOfBankAccounts totalTaxValue="${fmt(cashTax)}" totalGrossRevenueA="${fmt(bankInterest)}" totalGrossRevenueB="0" totalWithHoldingTaxClaim="0">\n${accts.join("\n")}\n  </listOfBankAccounts>\n`;
    }

    // Identifiers
    const clearing = (cfg.clearing || "06435").replace(/\D/g, "").slice(0, 5).padStart(5, "0");
    const cust = (cfg.clientNumber || "").replace(/[^A-Za-z0-9]/g, "").slice(0, 14).padEnd(14, "X");
    const id = `${(cfg.country || "CH").slice(0, 2)}${clearing}${cust}${cfg.taxYear}1231` + "01";
    const creation = `${cfg.taxYear}-12-31T12:00:00+00:00`;

    const listSec =
      `  <listOfSecurities totalTaxValue="${fmt(secTotalsTax)}" totalGrossRevenueA="${fmt(secTotalsA)}" totalGrossRevenueB="${fmt(secTotalsB)}" totalWithHoldingTaxClaim="${fmt(secTotalsWht)}" totalLumpSumTaxCredit="0" totalNonRecoverableTax="0" totalAdditionalWithHoldingTaxUSA="0" totalGrossRevenueIUP="0" totalGrossRevenueConversion="0">\n` +
      `    <depot depotNumber="${xmlEsc(cfg.depot || "1")}">\n${secXml.join("\n")}\n    </depot>\n  </listOfSecurities>\n`;

    const client =
      `  <client clientNumber="${xmlEsc(cfg.clientNumber || "SQ-ACCOUNT")}"` +
      (cfg.firstName ? ` firstName="${xmlEsc(cfg.firstName)}"` : "") +
      (cfg.lastName ? ` lastName="${xmlEsc(cfg.lastName)}"` : "") + "/>\n";

    const header =
      `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<taxStatement xmlns="http://www.ech.ch/xmlns/eCH-0196/2" ` +
      `xmlns:eCH-0097="http://www.ech.ch/xmlns/eCH-0097/4" ` +
      `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
      `xsi:schemaLocation="http://www.ech.ch/xmlns/eCH-0196/2 http://www.ech.ch/xmlns/eCH-0196/2.2/eCH-0196-2-2.xsd http://www.ech.ch/xmlns/eCH-0097/4 http://www.ech.ch/xmlns/eCH-0097/4/eCH-0097-4-0.xsd" ` +
      `id="${id}" creationDate="${creation}" taxPeriod="${cfg.taxYear}" periodFrom="${periodFrom}" periodTo="${periodTo}" ` +
      `country="${(cfg.country || "CH").slice(0, 2)}" canton="${cfg.canton || "ZH"}" minorVersion="2" ` +
      `totalTaxValue="${fmt(totTax)}" totalGrossRevenueA="${fmt(totA)}" totalGrossRevenueB="${fmt(totB)}" totalWithHoldingTaxClaim="${fmt(totWht)}">\n`;

    const xml = header +
      `  <institution name="${xmlEsc(cfg.institution || "Swissquote Bank AG")}"/>\n` +
      client + bankXml + listSec + `</taxStatement>\n`;

    return {
      xml,
      totals: { taxValue: totTax, grossA: totA, grossB: totB, wht: totWht, cashTax, bankInterest },
      securitiesCount: posId - 1,
    };
  }

  return { parseCsv, classify, buildXml, valorFromIsin, _fmt: fmt };
});
