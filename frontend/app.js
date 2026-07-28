"use strict";

// ---- State ----------------------------------------------------------------
let selectedFile = null;
let analysis = null;      // response from /api/analyze
let lastResult = null;    // response from /api/generate
let lastConfig = null;    // config sent to /api/generate (reused for PDF)

const $ = (id) => document.getElementById(id);

// ---- Formatting -----------------------------------------------------------
const chf = (n) =>
  new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF", maximumFractionDigits: 2 }).format(n || 0);
const num = (n, d = 0) =>
  new Intl.NumberFormat("de-CH", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// ---- Theme ----------------------------------------------------------------
$("themeToggle").addEventListener("click", () => {
  const root = document.documentElement;
  const current = root.getAttribute("data-theme");
  const dark = current
    ? current === "dark"
    : window.matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", dark ? "light" : "dark");
});

// ---- Step navigation ------------------------------------------------------
function showStep(step) {
  $("section-upload").hidden = step !== 1;
  $("section-form").hidden = step !== 2;
  $("section-result").hidden = step !== 3;
  document.querySelectorAll(".step-pill").forEach((p) => {
    const n = Number(p.dataset.step);
    p.classList.toggle("active", n === step);
    p.classList.toggle("done", n < step);
  });
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---- File selection -------------------------------------------------------
const dropzone = $("dropzone");
const fileInput = $("fileInput");

dropzone.addEventListener("click", () => fileInput.click());
dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("drag"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("drag"));
dropzone.addEventListener("drop", (e) => {
  e.preventDefault();
  dropzone.classList.remove("drag");
  if (e.dataTransfer.files.length) setFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener("change", () => { if (fileInput.files.length) setFile(fileInput.files[0]); });

function setFile(file) {
  selectedFile = file;
  const el = $("fileName");
  el.textContent = "✓ " + file.name;
  el.hidden = false;
  $("analyzeBtn").disabled = false;
  $("uploadError").hidden = true;
}

// ---- Analyze --------------------------------------------------------------
$("analyzeBtn").addEventListener("click", async () => {
  if (!selectedFile) return;
  const btn = $("analyzeBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Analysiere…';
  try {
    const fd = new FormData();
    fd.append("file", selectedFile);
    const res = await fetch("/api/analyze", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || "Analyse fehlgeschlagen.");
    analysis = data;
    populateForm(data);
    $("previewHost").innerHTML =
      '<div class="card"><h2>Vorschau</h2><p class="hint">Basierend auf Standard‑Kursen – die Zahlen aktualisieren sich beim Erzeugen.</p>' +
      dashboardHtml(data.summary, { preview: true }) + "</div>";
    showStep(2);
  } catch (err) {
    const e = $("uploadError");
    e.textContent = err.message;
    e.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Analysieren";
  }
});

// ---- Populate the questions form -----------------------------------------
function populateForm(data) {
  // Year selector: a range around the detected year, defaulting to it.
  const y = data.tax_year;
  const years = [];
  for (let yr = y + 1; yr >= y - 6; yr--) years.push(yr);
  const yearSel = $("f_year");
  yearSel.innerHTML = years
    .map((yr) => `<option value="${yr}"${yr === y ? " selected" : ""}>${yr}</option>`)
    .join("");
  yearSel.value = String(y);

  const canton = $("f_canton");
  canton.innerHTML = data.cantons.map((c) => `<option value="${c}">${c}</option>`).join("");
  canton.value = "ZH";

  const grid = $("fxGrid");
  grid.innerHTML = "";
  data.currencies
    .filter((c) => c !== "CHF")
    .forEach((c) => {
      const rate = data.default_fx_rates[c] || "1";
      grid.insertAdjacentHTML(
        "beforeend",
        `<div class="field"><label>1 ${esc(c)} = … CHF</label>
           <input class="fx" data-ccy="${esc(c)}" type="number" step="0.0001" value="${esc(rate)}"></div>`
      );
    });
  if (!grid.children.length) {
    grid.innerHTML = '<p class="muted-note">Alle Beträge sind bereits in CHF – keine Umrechnung nötig.</p>';
  }
}

function collectConfig() {
  const fx = {};
  document.querySelectorAll(".fx").forEach((i) => (fx[i.dataset.ccy] = i.value || "1"));
  return {
    tax_year: Number($("f_year").value) || analysis.tax_year,
    canton: $("f_canton").value,
    first_name: $("f_first").value,
    last_name: $("f_last").value,
    client_number: $("f_client").value,
    depot_number: $("f_depot").value || "1",
    institution_name: $("f_institution").value || "Swissquote Bank AG",
    country: ($("f_country").value || "CH").toUpperCase().slice(0, 2),
    include_options: $("t_options").checked,
    include_crypto: $("t_crypto").checked,
    include_metals: $("t_metals").checked,
    tax_value_mode: $("f_taxmode").value,
    fx_rates: fx,
  };
}

$("backBtn").addEventListener("click", () => showStep(1));
$("restartBtn").addEventListener("click", () => {
  selectedFile = null; analysis = null; lastResult = null;
  fileInput.value = ""; $("fileName").hidden = true; $("analyzeBtn").disabled = true;
  showStep(1);
});

// ---- Generate -------------------------------------------------------------
$("generateBtn").addEventListener("click", async () => {
  const btn = $("generateBtn");
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Erzeuge…';
  $("formError").hidden = true;
  try {
    lastConfig = collectConfig();
    const fd = new FormData();
    fd.append("file", selectedFile);
    fd.append("config", JSON.stringify(lastConfig));
    const res = await fetch("/api/generate", { method: "POST", body: fd });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.detail || "Erzeugung fehlgeschlagen.");
    lastResult = data;
    renderResult(data);
    showStep(3);
  } catch (err) {
    const e = $("formError");
    e.textContent = err.message;
    e.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Steuerauszug erzeugen";
  }
});

// ---- Render result --------------------------------------------------------
function renderResult(data) {
  const v = data.validation;
  $("validationBadge").innerHTML = v.valid
    ? '<span class="badge ok">✓ eCH‑0196 v2.2 – XSD‑validiert</span>'
    : '<span class="badge bad">✗ Schema‑Validierung fehlgeschlagen</span>';

  $("validationErrors").innerHTML =
    v.valid || !v.errors.length
      ? ""
      : '<div class="banner warn" style="margin-top:12px"><span class="ico">⚠️</span><div><strong>Validierungshinweise:</strong><ul style="margin:6px 0 0 18px">' +
        v.errors.slice(0, 8).map((e) => `<li>${esc(e)}</li>`).join("") +
        "</ul></div></div>";

  $("dashboardHost").innerHTML =
    dashboardHtml(data.summary, { preview: false }) + reportHtml(data.report);
}

// ---- Download -------------------------------------------------------------
$("downloadBtn").addEventListener("click", () => {
  if (!lastResult) return;
  const blob = new Blob([lastResult.xml], { type: "application/xml" });
  triggerDownload(blob, lastResult.filename);
});

$("downloadPdfBtn").addEventListener("click", async () => {
  if (!selectedFile || !lastConfig) return;
  const btn = $("downloadPdfBtn");
  const original = btn.textContent;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span> Erzeuge PDF…';
  try {
    const fd = new FormData();
    fd.append("file", selectedFile);
    fd.append("config", JSON.stringify(lastConfig));
    const res = await fetch("/api/pdf", { method: "POST", body: fd });
    if (!res.ok) {
      let msg = "PDF konnte nicht erzeugt werden.";
      try { msg = (await res.json()).detail || msg; } catch (_) {}
      throw new Error(msg);
    }
    const blob = await res.blob();
    triggerDownload(blob, (lastResult && lastResult.filename || "eCH-0196_Swissquote").replace(/\.xml$/, "") + ".pdf");
  } catch (err) {
    alert(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
});

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ---- Dashboard rendering (reused for preview + result) --------------------
function kpi(cls, label, value, unit, foot) {
  return `<div class="kpi ${cls}"><div class="label">${esc(label)}</div>
    <div class="value">${value}${unit ? ` <span class="unit">${esc(unit)}</span>` : ""}</div>
    ${foot ? `<div class="foot">${esc(foot)}</div>` : ""}</div>`;
}

function barChart(rows, { unit = "CHF" } = {}) {
  if (!rows.length) return '<p class="muted-note">Keine Daten.</p>';
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    '<div class="chart">' +
    rows
      .map((r) => {
        const w = Math.max(2, (Math.abs(r.value) / max) * 100);
        const label = unit === "CHF" ? chf(r.value) : num(r.value, r.dp || 0);
        return `<div class="bar-row"><div class="name" title="${esc(r.name)}">${esc(r.name)}</div>
          <div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div>
          <div class="val">${label}</div></div>`;
      })
      .join("") +
    "</div>"
  );
}

const MONTHS = ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"];

function dashboardHtml(s, { preview }) {
  const d = s.dividenden;
  const income = (d.gross_chf || 0) + (s.bank_interest_chf || 0);

  const kpis =
    '<div class="kpis" style="margin-bottom:20px">' +
    kpi("accent-1", "Zugänge (Käufe)", num(s.zugaenge.count), "Trans.", `Volumen ${chf(s.zugaenge.total_chf)}`) +
    kpi("accent-2", "Abgänge (Verkäufe)", num(s.abgaenge.count), "Trans.", `Volumen ${chf(s.abgaenge.total_chf)}`) +
    kpi("accent-3", "Dividenden & Erträge", chf(income), "", `${num(d.count)} Zahlungen`) +
    kpi("accent-4", "Verrechnungssteuer", chf(d.swiss_withholding_chf), "", "rückforderbar (CH)") +
    "</div>";

  // Dividends by month
  const monthRows = (d.by_month || []).map((m) => {
    const mm = Number(m.month.split("-")[1]);
    return { name: MONTHS[mm - 1] + " " + m.month.split("-")[0].slice(2), value: m.gross_chf };
  });

  // Category breakdown
  const catRows = (s.category_breakdown || [])
    .filter((c) => c.value_chf > 0)
    .map((c) => ({ name: catLabel(c.category), value: c.value_chf }));

  const charts =
    '<div class="split">' +
    `<div class="card"><h2>Dividenden nach Monat</h2><p class="hint">Bruttoertrag pro Monat (CHF)</p>${barChart(monthRows)}</div>` +
    `<div class="card"><h2>Geschätzter Depotwert nach Kategorie</h2><p class="hint">Nach letztem Handelskurs · Schätzung</p>${barChart(catRows)}</div>` +
    "</div>";

  const summaryCard =
    '<div class="card"><h2>Zusammenfassung Steuerjahr ' + esc(s.tax_year) + "</h2>" +
    '<div class="grid3">' +
    miniStat("Positionen per 31.12.", num(s.totals.positions)) +
    miniStat("Gehandelte Instrumente", num(s.totals.instruments_traded)) +
    miniStat("Geschätzter Steuerwert", chf(s.totals.estimated_portfolio_chf)) +
    miniStat("Dividenden brutto", chf(d.gross_chf)) +
    miniStat("Ausländische Quellensteuer", chf(d.foreign_withholding_chf)) +
    miniStat("Zinsen auf Einlagen", chf(s.bank_interest_chf)) +
    "</div>" +
    (preview ? "" : cashNote(s)) +
    "</div>";

  const divTable = dividendTable(d.top);
  const posTable = preview ? "" : positionsTable(s.positions);

  return kpis + summaryCard + charts + divTable + posTable;
}

function miniStat(label, value) {
  return `<div class="field"><label>${esc(label)}</label><div style="font-size:20px;font-weight:700">${value}</div></div>`;
}

function catLabel(c) {
  return { SHARE: "Aktien", FUND: "Fonds/ETF", OPTION: "Optionen", OTHER: "Krypto/Andere", BOND: "Obligationen", COINBULL: "Edelmetalle" }[c] || c;
}

function cashNote(s) {
  const e = s.excluded;
  return (
    '<div class="banner info" style="margin-top:16px"><span class="ico">🧮</span><div>' +
    "Nicht im Wertschriftenverzeichnis enthalten (reine Geldkonto‑Bewegungen): " +
    `Kartenzahlungen ${chf(e.card_spending_chf)}, Einzahlungen ${chf(e.deposits_chf)} ` +
    `(${num(e.ignored_cash_rows)} Zeilen). Diese gehören nicht in den Wertschriftenauszug.` +
    "</div></div>"
  );
}

function dividendTable(items) {
  if (!items || !items.length) return "";
  return (
    '<div class="card"><h2>Grösste Dividenden & Erträge</h2><div class="table-wrap"><table>' +
    "<thead><tr><th>Datum</th><th>Titel</th><th>Art</th><th class=num>Brutto</th><th class=num>Quellenst.</th><th class=num>Netto</th><th>CH</th></tr></thead><tbody>" +
    items
      .map(
        (i) =>
          `<tr><td>${esc(i.date)}</td><td title="${esc(i.name)}">${esc(i.name.length > 34 ? i.name.slice(0, 33) + "…" : i.name)}</td>
        <td>${esc(i.type)}</td><td class=num>${num(i.gross, 2)} ${esc(i.currency)}</td>
        <td class=num>${num(i.tax, 2)}</td><td class=num>${num(i.net, 2)}</td>
        <td>${i.swiss ? '<span class="tag">CH</span>' : ""}</td></tr>`
      )
      .join("") +
    "</tbody></table></div></div>"
  );
}

function positionsTable(positions) {
  const held = positions.filter((p) => p.closing_quantity !== 0);
  if (!held.length) return "";
  return (
    '<div class="card"><h2>Rekonstruierte Bestände per 31.12.</h2>' +
    '<p class="hint">Aus den Transaktionen berechnet. „rekonstr.“ = Anfangsbestand aus einem Verkauf abgeleitet (Titel vor dem Steuerjahr gehalten).</p>' +
    '<div class="table-wrap"><table>' +
    "<thead><tr><th>Titel</th><th>ISIN</th><th>Kat.</th><th class=num>Bestand</th><th class=num>Steuerwert (Schätz.)</th><th class=num>Ertrag</th></tr></thead><tbody>" +
    held
      .map(
        (p) =>
          `<tr><td title="${esc(p.name)}">${esc(p.name.length > 32 ? p.name.slice(0, 31) + "…" : p.name)}
        ${p.opening_inferred ? '<span class="tag est">rekonstr.</span>' : ""}</td>
        <td>${esc(p.isin || "—")}</td><td>${esc(catLabel(p.category))}</td>
        <td class=num>${num(p.closing_quantity, p.closing_quantity % 1 ? 4 : 0)} ${esc(p.currency)}</td>
        <td class=num>${chf(p.tax_value_chf)} <span class="tag est">Schätz.</span></td>
        <td class=num>${chf(p.income_chf)}</td></tr>`
      )
      .join("") +
    "</tbody></table></div></div>"
  );
}

function reportHtml(report) {
  if (!report) return "";
  let html = "";
  if (report.excluded && report.excluded.length) {
    html +=
      '<div class="banner warn"><span class="ico">⚠️</span><div><strong>Ausgeschlossene Positionen:</strong> ' +
      report.excluded.map(esc).join(", ") +
      "</div></div>";
  }
  if (report.warnings && report.warnings.length) {
    html +=
      '<div class="banner warn" style="margin-top:10px"><span class="ico">⚠️</span><div>' +
      report.warnings.map(esc).join("<br>") +
      "</div></div>";
  }
  return html ? '<div class="card">' + html + "</div>" : "";
}
