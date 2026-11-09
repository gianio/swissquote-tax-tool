"use strict";
// Browser-only app glue. Everything runs client-side; the Content-Security-
// Policy in index.html prevents any request to a foreign server.
pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);
const CANTONS = {
  AG: "Aargau", AI: "Appenzell Innerrhoden", AR: "Appenzell Ausserrhoden", BE: "Bern",
  BL: "Basel-Landschaft", BS: "Basel-Stadt", FR: "Freiburg", GE: "Genf", GL: "Glarus",
  GR: "Graubünden", JU: "Jura", LU: "Luzern", NE: "Neuenburg", NW: "Nidwalden", OW: "Obwalden",
  SG: "St. Gallen", SH: "Schaffhausen", SO: "Solothurn", SZ: "Schwyz", TG: "Thurgau", TI: "Tessin",
  UR: "Uri", VD: "Waadt", VS: "Wallis", ZG: "Zug", ZH: "Zürich",
};
const DEFAULT_FX = { USD: "0.80", EUR: "0.93", CAD: "0.58", DKK: "0.125", GBP: "1.08", SEK: "0.083", NOK: "0.080", JPY: "0.0055", XAU: "3400" };
const CANTON_KEY = "est-canton";

let txns = null, cashBalances = [], account = {}, currencies = [], sourceLabel = "";
let importSkipped = [];
let table = null;
let lastXml = null, lastCfg = null;

const chf = (n) => new Intl.NumberFormat("de-CH", { style: "currency", currency: "CHF", maximumFractionDigits: 2 }).format(n || 0);
const num = (n, d = 0) => new Intl.NumberFormat("de-CH", { minimumFractionDigits: d, maximumFractionDigits: d }).format(n || 0);
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } };

// ---- chrome ----------------------------------------------------------------
$("themeToggle").addEventListener("click", () => {
  const root = document.documentElement, cur = root.getAttribute("data-theme");
  const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", dark ? "light" : "dark");
});
SQConsent.show();
$("showConsent").addEventListener("click", () => SQConsent.show(true));

function setStep(n) {
  document.querySelectorAll("#stepper li").forEach((li) => {
    const s = +li.dataset.step;
    li.classList.toggle("active", s === n);
    li.classList.toggle("done", s < n);
  });
}
function showErr(id, msg) { const el = $(id); el.textContent = msg; el.hidden = !msg; }
function resetAfterSource() {
  ["mapCard", "manualCard", "formCard", "resultCard"].forEach((id) => ($(id).hidden = true));
  $("dashboardHost").innerHTML = "";
  lastXml = null; cashBalances = []; account = {}; importSkipped = []; txns = null;
}

// ---- step 1: file ------------------------------------------------------------
const dz = $("dropzone"), fi = $("fileInput");
dz.addEventListener("click", () => fi.click());
dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fi.click(); } });
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
fi.addEventListener("change", () => { if (fi.files[0]) loadFile(fi.files[0]); fi.value = ""; });

async function loadFile(file) {
  showErr("err", ""); resetAfterSource();
  $("parseStatus").textContent = "Verarbeite lokal …";
  $("fileName").textContent = "✓ " + file.name; $("fileName").hidden = false;
  try {
    const buf = await file.arrayBuffer();
    const head = new Uint8Array(buf.slice(0, 5)).reduce((s, b) => s + String.fromCharCode(b), "");
    if (head === "%PDF-" || /\.pdf$/i.test(file.name)) {
      let k;
      try { k = await SQPdf.parseKontoauszug(buf, pdfjsLib); }
      catch (e) {
        throw new Error(e.message + " – Automatisch gelesen werden Swissquote‑Kontoauszüge. Für andere Banken laden Sie bitte den CSV‑Export aus dem E‑Banking hoch oder erfassen die Werte manuell.");
      }
      txns = k.transactions; cashBalances = k.balances; account = k.account;
      sourceLabel = "Swissquote‑Kontoauszug (PDF)";
      $("parseStatus").textContent = `✓ ${sourceLabel}: ${txns.length} Transaktionen, ${k.balances.length} Kontostände`;
      return goToForm();
    }
    const text = SQImport.decodeBytes(buf);
    table = SQImport.readTable(text);
    if (SQImport.isSwissquote(table.header)) {
      txns = SQCore.parseCsv(text);
      sourceLabel = "Swissquote‑Transaktionsexport (CSV)";
      $("parseStatus").textContent = `✓ ${sourceLabel}: ${txns.length} Transaktionen`;
      return goToForm();
    }
    sourceLabel = "CSV‑Export";
    $("parseStatus").textContent = `✓ ${table.rows.length} Zeilen, ${table.header.length} Spalten erkannt – bitte Zuordnung prüfen.`;
    openMapping();
  } catch (e) {
    showErr("err", e.message); $("parseStatus").textContent = "";
  }
}

// ---- step 2a: column mapping ----------------------------------------------------
let mapState = null;
function openMapping() {
  const profile = SQImport.findProfile(table.header);
  mapState = {
    mapping: profile ? { ...profile.mapping } : SQImport.guessMapping(table.header),
    typeMap: profile ? { ...profile.typeMap } : {},
  };
  $("profileNote").innerHTML = profile
    ? `<div class="banner info" style="margin-bottom:12px"><span class="ico">★</span><div>Gespeichertes Profil <strong>${esc(profile.name || "Bank")}</strong> angewendet.</div></div>`
    : "";
  $("profileName").value = profile ? profile.name || "" : "";
  if (profile && profile.decimal) $("m_decimal").value = profile.decimal;
  if (profile && profile.dateOrder) $("m_date").value = profile.dateOrder;

  const sample = (i) => { const r = table.rows.find((row) => row[i]); return r ? r[i] : ""; };
  $("mapGrid").innerHTML = SQImport.FIELDS.map((f) => {
    const opts = ['<option value="">— nicht vorhanden —</option>'].concat(table.header.map((h, i) =>
      `<option value="${i}"${mapState.mapping[f.id] === i ? " selected" : ""}>${esc(h)}${sample(i) ? " · " + esc(String(sample(i)).slice(0, 18)) : ""}</option>`));
    return `<div class="field"><label>${esc(f.label)}${f.required ? ' <span class="req">*</span>' : ""}</label><select class="map-sel" data-f="${f.id}">${opts.join("")}</select></div>`;
  }).join("");
  document.querySelectorAll(".map-sel").forEach((s) => s.addEventListener("change", () => {
    if (s.value === "") delete mapState.mapping[s.dataset.f]; else mapState.mapping[s.dataset.f] = +s.value;
    renderTypes(); renderMapPreview();
  }));
  ["m_decimal", "m_date", "m_ccy"].forEach((id) => ($(id).onchange = renderMapPreview));
  renderTypes(); renderMapPreview();
  $("mapCard").hidden = false; setStep(2);
  $("mapCard").scrollIntoView({ behavior: "smooth" });
}

function typeOptions(sel) {
  return ['<option value="">— bitte wählen —</option>'].concat(SQImport.TYPES.map((t) =>
    `<option value="${esc(t.id)}"${t.id === sel ? " selected" : ""}>${esc(t.label)}</option>`)).join("");
}
function renderTypes() {
  if (mapState.mapping.type == null) {
    $("typeTable").innerHTML = '<p class="muted-note">Keine Spalte für die Transaktionsart – Käufe/Verkäufe werden am Vorzeichen der Stückzahl erkannt.</p>';
    return;
  }
  const sugg = SQImport.typeSuggestions(table, mapState.mapping);
  $("typeTable").innerHTML = '<div class="table-wrap"><table><thead><tr><th>Wert in der Datei</th><th class=num>Zeilen</th><th>Bedeutung</th></tr></thead><tbody>' +
    sugg.map((s) => {
      const cur = mapState.typeMap[s.raw] != null ? mapState.typeMap[s.raw] : s.suggestion;
      return `<tr class="${cur ? "" : "needs"}"><td>${esc(s.raw || "(leer)")}</td><td class=num>${s.count}</td><td><select class="type-sel" data-raw="${esc(s.raw)}">${typeOptions(cur)}</select></td></tr>`;
    }).join("") + "</tbody></table></div>";
  document.querySelectorAll(".type-sel").forEach((s) => s.addEventListener("change", () => {
    mapState.typeMap[s.dataset.raw] = s.value || "ignorieren";
    s.closest("tr").classList.toggle("needs", !s.value);
    renderMapPreview();
  }));
}
function currentImport() {
  const typeMap = {};
  document.querySelectorAll(".type-sel").forEach((s) => { typeMap[s.dataset.raw] = s.value || "ignorieren"; });
  return SQImport.normalize(table, {
    mapping: mapState.mapping, typeMap,
    decimal: $("m_decimal").value || undefined, dateOrder: $("m_date").value || undefined,
    defaultCurrency: $("m_ccy").value,
  });
}
function renderMapPreview() {
  if (mapState.mapping.date == null) { $("mapPreview").innerHTML = '<p class="error">Bitte die Spalte „Datum“ zuordnen.</p>'; return; }
  const r = currentImport();
  const rows = r.txns.slice(0, 8).map((t) => `<tr><td>${esc(t.date)}</td><td>${esc(t.type)}</td><td title="${esc(t.name)}">${esc(String(t.name || "").slice(0, 28))}</td><td>${esc(t.isin || "—")}</td><td class=num>${t.quantity == null ? "" : num(t.quantity, t.quantity % 1 ? 4 : 0)}</td><td class=num>${t.net == null ? "" : num(t.net, 2)}</td><td>${esc(t.currency)}</td></tr>`).join("");
  $("mapPreview").innerHTML =
    `<p class="muted-note">${r.txns.length} Transaktionen · ${r.balances.length} Kontostände · ${r.skipped.length} übersprungen · Dezimal „${esc(r.decimal)}“ · Datum ${esc(r.dateOrder)}</p>` +
    (rows ? `<div class="table-wrap"><table><thead><tr><th>Datum</th><th>Art</th><th>Titel</th><th>ISIN</th><th class=num>Stück</th><th class=num>Betrag</th><th>Whg</th></tr></thead><tbody>${rows}</tbody></table></div>` : "") +
    (r.skipped.length ? `<details class="fold"><summary>Übersprungene Zeilen (${r.skipped.length})</summary><ul class="muted-note">${r.skipped.slice(0, 30).map((s) => `<li>Zeile ${s.line}: ${esc(s.reason)}</li>`).join("")}</ul></details>` : "");
}
$("mapApply").addEventListener("click", () => {
  if (mapState.mapping.date == null) return renderMapPreview();
  const r = currentImport();
  if (!r.txns.length && !r.balances.length) { $("mapPreview").insertAdjacentHTML("afterbegin", '<p class="error">Keine verwertbaren Zeilen – bitte Zuordnung prüfen.</p>'); return; }
  if ($("saveProfile").checked) {
    const typeMap = {};
    document.querySelectorAll(".type-sel").forEach((s) => { typeMap[s.dataset.raw] = s.value || "ignorieren"; });
    SQImport.saveProfile({ signature: SQImport.signature(table.header), name: $("profileName").value.trim(),
      mapping: mapState.mapping, typeMap, decimal: $("m_decimal").value, dateOrder: $("m_date").value });
  }
  txns = r.txns; cashBalances = r.balances; importSkipped = r.skipped;
  if ($("profileName").value.trim() && !$("f_institution").dataset.touched) $("f_institution").value = $("profileName").value.trim();
  goToForm();
});

// ---- step 2b: manual entry -------------------------------------------------------
$("manualBtn").addEventListener("click", () => {
  showErr("err", ""); resetAfterSource();
  sourceLabel = "Manuelle Erfassung";
  const tb = $("manualTable").querySelector("tbody");
  if (!tb.children.length) {
    const y = new Date().getFullYear() - 1;
    addManualRow({ type: "Bestand 31.12.", date: `31.12.${y}` });
    addManualRow({ type: "Dividende", date: "" });
    addManualRow({ type: "Kontostand 31.12.", date: `31.12.${y}` });
  }
  $("manualCard").hidden = false; setStep(2);
  $("manualCard").scrollIntoView({ behavior: "smooth" });
});
$("manualAdd").addEventListener("click", () => addManualRow({ type: "Bestand 31.12.", date: `31.12.${new Date().getFullYear() - 1}` }));
function addManualRow(v) {
  const types = SQImport.TYPES.filter((t) => !["Zahlung", "Depotgebühren", "ignorieren"].includes(t.id));
  const tr = document.createElement("tr");
  tr.innerHTML = `<td><select class="m-type">${types.map((t) => `<option value="${esc(t.id)}"${t.id === v.type ? " selected" : ""}>${esc(t.label)}</option>`).join("")}</select></td>
    <td><input class="m-date" value="${esc(v.date || "")}" placeholder="TT.MM.JJJJ" style="width:104px"></td>
    <td><input class="m-isin" placeholder="CH…" style="width:128px" maxlength="12"></td>
    <td><input class="m-name" placeholder="z.B. Nestlé AG"></td>
    <td><input class="m-qty num" inputmode="decimal" style="width:80px"></td>
    <td><input class="m-net num" inputmode="decimal" style="width:96px"></td>
    <td><input class="m-costs num" inputmode="decimal" style="width:84px"></td>
    <td><input class="m-ccy" value="CHF" maxlength="3" style="width:56px"></td>
    <td><button class="btn ghost small" type="button" aria-label="Zeile entfernen">✕</button></td>`;
  tr.querySelector("button").addEventListener("click", () => tr.remove());
  $("manualTable").querySelector("tbody").appendChild(tr);
}
$("manualApply").addEventListener("click", () => {
  const rows = [];
  $("manualTable").querySelectorAll("tbody tr").forEach((tr) => {
    const g = (c) => tr.querySelector(c).value.trim();
    const r = { type: g(".m-type"), date: g(".m-date"), isin: g(".m-isin"), name: g(".m-name"),
      quantity: g(".m-qty"), net: g(".m-net"), costs: g(".m-costs"), currency: g(".m-ccy") || "CHF" };
    if (r.isin || r.name || r.quantity || r.net) rows.push(r);
  });
  const r = SQImport.fromManual(rows, "CHF");
  if (!r.txns.length && !r.balances.length) { showErr("err", "Bitte mindestens eine Zeile ausfüllen."); $("err").scrollIntoView({ behavior: "smooth" }); return; }
  showErr("err", "");
  txns = r.txns; cashBalances = r.balances; importSkipped = r.skipped;
  goToForm();
});

// ---- step 3: form ------------------------------------------------------------------
$("f_institution").addEventListener("input", (e) => { e.target.dataset.touched = "1"; });

function goToForm() {
  setupForm();
  $("formCard").hidden = false; setStep(3);
  $("formCard").scrollIntoView({ behavior: "smooth" });
}

function setupForm() {
  const years = new Set((txns || []).map((t) => Math.floor(t.dateKey / 10000)));
  const y = [...years].sort().reverse()[0] || new Date().getFullYear() - 1;
  const yo = []; for (let yr = Math.max(y + 1, new Date().getFullYear()); yr >= y - 6; yr--) yo.push(yr);
  $("f_year").innerHTML = yo.map((yr) => `<option value="${yr}"${yr === y ? " selected" : ""}>${yr}</option>`).join("");
  const savedCanton = lsGet(CANTON_KEY);
  $("f_canton").innerHTML = '<option value="">— Kanton wählen —</option>' + Object.entries(CANTONS)
    .map(([k, v]) => `<option value="${k}"${k === savedCanton ? " selected" : ""}>${k} – ${esc(v)}</option>`).join("");
  if (account.holderName) { const p = account.holderName.split(" "); $("f_first").value = p.slice(0, -1).join(" "); $("f_last").value = p[p.length - 1]; }
  if (account.customerNumber) $("f_client").value = account.customerNumber;

  const ccyset = new Set((txns || []).map((t) => t.currency).filter((c) => c && c !== "CHF"));
  cashBalances.forEach((b) => { if (b.currency && b.currency !== "CHF") ccyset.add(b.currency); });
  currencies = [...ccyset].sort();
  $("fxGrid").innerHTML = currencies.length
    ? currencies.map((c) => `<div class="field"><label>1 ${esc(c)} = … CHF</label><input class="fx" data-ccy="${esc(c)}" type="number" step="0.0001" value="${DEFAULT_FX[c] || "1"}"></div>`).join("")
    : '<p class="muted-note">Alle Beträge in CHF – keine Umrechnung nötig.</p>';
  $("fxSummary").textContent = currencies.length ? `(${currencies.join(", ")})` : "(nur CHF)";
  $("fxFold").open = currencies.length > 0;
}

function collectCfg() {
  const fx = { CHF: 1 };
  document.querySelectorAll(".fx").forEach((i) => (fx[i.dataset.ccy] = Number(i.value) || 1));
  return {
    taxYear: Number($("f_year").value), canton: $("f_canton").value,
    firstName: $("f_first").value.trim(), lastName: $("f_last").value.trim(),
    clientNumber: $("f_client").value.trim(), taxValueMode: $("f_taxmode").value,
    institution: $("f_institution").value.trim() || "Musterbank AG",
    clearing: $("f_clearing").value.trim() || "00000",
    fxRates: fx, cashBalances, openingPositions: collectCarry(),
  };
}
function validateCfg(cfg) {
  const miss = [];
  if (!cfg.firstName) miss.push("Vorname");
  if (!cfg.lastName) miss.push("Nachname");
  if (!cfg.canton) miss.push("Wohnkanton");
  if (!cfg.taxYear) miss.push("Steuerjahr");
  ["f_first", "f_last", "f_canton"].forEach((id) => $(id).classList.toggle("invalid", !$(id).value.trim()));
  if (cfg.clearing && !/^\d{1,5}$/.test(cfg.clearing)) return "Die BC‑/Clearing‑Nummer besteht aus bis zu 5 Ziffern.";
  return miss.length ? "Bitte ausfüllen: " + miss.join(", ") + "." : "";
}

// ---- carry-forward -----------------------------------------------------------------
$("cfBtn").addEventListener("click", () => $("cfInput").click());
$("cfInput").addEventListener("change", async () => {
  const file = $("cfInput").files[0]; if (!file) return;
  $("cfStatus").textContent = "Lese Positionen …";
  try {
    const buf = await file.arrayBuffer();
    const positions = await SQCarry.parse(buf, file.name, pdfjsLib);
    renderCarryTable(positions);
    const withQ = positions.filter((p) => p.quantity !== "").length;
    $("cfStatus").textContent = `✓ ${positions.length} Positionen (${withQ} mit Bestand) – bitte prüfen.`;
  } catch (e) { $("cfStatus").textContent = "⚠ " + e.message; }
});
function renderCarryTable(positions) {
  if (!positions.length) { $("cfTableHost").innerHTML = ""; return; }
  const rows = positions.map((p) => `<tr>
    <td><input class="cf-isin" value="${esc(p.isin)}" style="width:118px"></td>
    <td title="${esc(p.name)}">${esc(p.name.length > 24 ? p.name.slice(0, 23) + "…" : p.name)}</td>
    <td><input class="cf-valor" value="${esc(p.valor ?? "")}" style="width:92px" placeholder="—"></td>
    <td><input class="cf-qty" value="${esc(p.quantity)}" style="width:78px" placeholder="Bestand"></td></tr>`).join("");
  $("cfTableHost").innerHTML = '<div class="banner info" style="margin-bottom:8px"><span class="ico">↪</span><div>Anfangsbestand (01.01.) je Titel – aus der Datei vorausgefüllt. Stückzahl/Valor prüfen; leere Bestände werden ignoriert.</div></div>' +
    '<div class="table-wrap"><table><thead><tr><th>ISIN</th><th>Titel</th><th>Valor</th><th>Bestand 01.01.</th></tr></thead><tbody>' + rows + '</tbody></table></div>';
}
function collectCarry() {
  const host = $("cfTableHost"); if (!host || !host.querySelector("table")) return [];
  const out = [];
  host.querySelectorAll("tbody tr").forEach((tr) => {
    const isin = tr.querySelector(".cf-isin").value.trim();
    const valor = tr.querySelector(".cf-valor").value.trim();
    const qty = tr.querySelector(".cf-qty").value.trim();
    if (isin) out.push({ isin, valor: valor || null, quantity: qty || "" });
  });
  return out;
}

// ---- generate --------------------------------------------------------------------
$("genBtn").addEventListener("click", () => {
  try {
    const cfg = collectCfg();
    const problem = validateCfg(cfg);
    showErr("formErr", problem);
    if (problem) return;
    lsSet(CANTON_KEY, cfg.canton);
    const res = SQCore.classify(txns || [], "CH");
    const out = SQCore.buildXml(res, cfg);
    const sum = SQCore.summarize(res, cfg, cashBalances);
    lastXml = out.xml; lastCfg = cfg;
    const wf = !new DOMParser().parseFromString(out.xml, "application/xml").querySelector("parsererror");
    $("badge").innerHTML = (wf
      ? `<span class="badge ok">✓ eCH‑0196 v2.2 · Kanton ${esc(cfg.canton)} · ${esc(cfg.taxYear)}</span>`
      : '<span class="badge bad">✗ XML‑Fehler</span>')
      + (out.carriedCount ? ` <span class="badge ok">↪ ${out.carriedCount} aus Vorjahr weitergeführt</span>` : "");
    const warns = res.warnings.concat(importSkipped.filter((s) => s.reason !== "ignoriert").map((s) => `Zeile ${s.line}: ${s.reason}`));
    $("warnHost").innerHTML = warns.length
      ? `<details class="fold"><summary>⚠ ${warns.length} Hinweis${warns.length > 1 ? "e" : ""} zur Datenqualität</summary><ul class="muted-note">${warns.slice(0, 40).map((w) => `<li>${esc(w)}</li>`).join("")}</ul></details>` : "";
    $("priceNote").textContent = SQPay.isLocked()
      ? `Download einmalig CHF ${SQPay.priceChf} · Bezahlung mit TWINT oder Kreditkarte`
      : "Download derzeit kostenlos.";
    $("previewHost").innerHTML = previewHtml(cfg, out, res, SQPay.isLocked());
    $("resultCard").hidden = false; setStep(4);
    $("dashboardHost").innerHTML = dashboardHtml(sum);
    $("resultCard").scrollIntoView({ behavior: "smooth" });
  } catch (e) { showErr("formErr", e.message); }
});

// ---- downloads (behind the optional paywall) -------------------------------------
async function unlockOrAbort() {
  const ok = await SQPay.requireUnlock();
  if (ok && lastCfg) $("previewHost").innerHTML = previewHtml(lastCfg, null, null, false);
  if (ok) $("priceNote").textContent = SQPay.isLocked() ? "" : "✓ Freigeschaltet";
  return ok;
}
$("dlBtn").addEventListener("click", async () => {
  if (!lastXml || !(await unlockOrAbort())) return;
  download(new Blob([lastXml], { type: "application/xml" }), `eCH-0196_${$("f_year").value}.xml`);
});
$("dlPdfBtn").addEventListener("click", async () => {
  if (!lastXml || !(await unlockOrAbort())) return;
  const btn = $("dlPdfBtn"), orig = btn.textContent; btn.disabled = true;
  const setP = (m) => { $("pdfStatus").textContent = m; };
  btn.innerHTML = '<span class="spinner"></span> Erzeuge …';
  try {
    const idM = lastXml.match(/\bid="([^"]+)"/);
    const y = Number($("f_year").value);
    const creationTs = Date.UTC(y, 11, 31, 12, 0, 0) / 1000;
    const institution = $("f_institution").value.trim() || "Musterbank AG";
    const pdfBytes = await SQBarcode.generate(lastXml, { statementId: idM ? idM[1] : "STATEMENT", creationTs, taxYear: y, institution }, setP);
    download(new Blob([pdfBytes], { type: "application/pdf" }), `eCH-0196_${y}.pdf`);
    setP("✓ Barcode‑PDF erzeugt.");
  } catch (e) { setP("⚠ " + e.message); }
  finally { btn.disabled = false; btn.textContent = orig; }
});
function download(blob, name) {
  const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
  a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---- statement preview --------------------------------------------------------------
// A partial rendering of the generated statement so users can verify the data
// before paying. When locked, rows after the first few are masked (not just
// blurred) so the preview never contains the full statement.
let previewCache = null;
function previewHtml(cfg, out, res, locked) {
  if (out && res) previewCache = { out, res };
  ({ out, res } = previewCache);
  const rate = (c) => (cfg.fxRates[c] != null ? Number(cfg.fxRates[c]) : 1);
  const VISIBLE = 3;
  const secRows = res.instruments.filter((i) => i.closingQty !== 0 || i.income.length || i.movements.length).map((i) => {
    const inc = i.income.reduce((a, x) => a + x.gross * rate(x.currency), 0);
    const valor = i.valorOverride != null ? i.valorOverride : SQCore.valorFromIsin(i.isin);
    return { valor: valor || "", isin: i.isin || "—", name: i.name, qty: i.closingQty, ccy: i.currency,
      a: i.country === "CH" ? inc : 0, b: i.country === "CH" ? 0 : inc };
  });
  const row = (r) => `<tr><td>${esc(r.valor)}</td><td>${esc(r.isin)}</td><td title="${esc(r.name)}">${esc(String(r.name).slice(0, 34))}</td><td class=num>${num(r.qty, r.qty % 1 ? 4 : 0)} ${esc(r.ccy)}</td><td class=num>${r.a ? num(r.a, 2) : ""}</td><td class=num>${r.b ? num(r.b, 2) : ""}</td></tr>`;
  const maskRow = () => `<tr class="masked"><td>•••••••</td><td>••••••••••••</td><td>•••••••••••••••••</td><td class=num>•••</td><td class=num>••••</td><td class=num>••••</td></tr>`;
  const shown = locked ? secRows.slice(0, VISIBLE) : secRows.slice(0, 60);
  const hidden = locked ? Math.max(0, secRows.length - VISIBLE) : Math.max(0, secRows.length - 60);
  const lockedBlock = locked && hidden
    ? `<tbody class="masked-group">${Array.from({ length: Math.min(hidden, 4) }, maskRow).join("")}</tbody>`
    : "";
  const t = out.totals;
  const cash = (cfg.cashBalances || []).filter((b) => b.currency !== "XAU");
  return `<div class="statement-preview" aria-label="Vorschau Steuerauszug">
    <div class="sp-head">
      <div><div class="sp-bank">${esc(cfg.institution)}</div><div class="sp-title">Steuerauszug per 31.12.${esc(cfg.taxYear)}</div></div>
      <dl class="sp-meta">
        <dt>Kunde</dt><dd>${esc(cfg.firstName)} ${esc(cfg.lastName)}</dd>
        <dt>Kdnr.</dt><dd>${esc(cfg.clientNumber || "—")}</dd>
        <dt>Periode</dt><dd>01.01.${esc(cfg.taxYear)} – 31.12.${esc(cfg.taxYear)}</dd>
        <dt>Kanton</dt><dd>${esc(cfg.canton)}</dd>
      </dl>
    </div>
    <table class="sp-totals"><thead><tr><th>Steuerwert 31.12.</th><th>Bruttoertrag A<br><span class="desc">mit VSt</span></th><th>Bruttoertrag B<br><span class="desc">ohne VSt</span></th><th>VSt‑Anspruch</th></tr></thead>
      <tbody><tr><td>${cfg.taxValueMode === "estimate" ? chf(t.taxValue) : (t.cashTax ? chf(t.cashTax) + " + Kursliste" : "gem. Kursliste")}</td><td>${chf(t.grossA)}</td><td>${chf(t.grossB)}</td><td>${chf(t.wht)}</td></tr></tbody></table>
    <div class="sp-sub">Wertschriftenverzeichnis · ${secRows.length} Position${secRows.length === 1 ? "" : "en"}</div>
    <div class="table-wrap sp-wrap"><table>
      <thead><tr><th>Valor</th><th>ISIN</th><th>Bezeichnung</th><th class=num>Bestand 31.12.</th><th class=num>Ertrag A CHF</th><th class=num>Ertrag B CHF</th></tr></thead>
      <tbody>${shown.map(row).join("") || '<tr><td colspan="6" class="muted-note">Keine Wertschriften</td></tr>'}</tbody>
      ${lockedBlock}
    </table>
    ${locked && hidden ? `<div class="sp-lock">🔒 ${hidden} weitere Position${hidden === 1 ? "" : "en"} im vollständigen Steuerauszug</div>` : (hidden ? `<p class="muted-note">… und ${hidden} weitere</p>` : "")}
    </div>
    ${cash.length ? `<div class="sp-sub">Konten</div><div class="table-wrap"><table><thead><tr><th>Konto</th><th class=num>Saldo 31.12.</th></tr></thead><tbody>${cash.map((b, i) =>
      locked && i >= 1 ? `<tr class="masked"><td>${esc(cfg.institution)} •••</td><td class=num>•••••</td></tr>` : `<tr><td>${esc(cfg.institution)} ${esc(b.currency)}</td><td class=num>${num(b.amount, 2)} ${esc(b.currency)}</td></tr>`).join("")}</tbody></table></div>` : ""}
    <div class="sp-foot">Quelle: ${esc(sourceLabel || "—")} · eCH‑0196 v2.2 · nicht bank‑signiert</div>
  </div>`;
}

// ---- dashboard ----------------------------------------------------------------------
function kpi(cls, label, value, foot) {
  return `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div>${foot ? `<div class="foot">${esc(foot)}</div>` : ""}</div>`;
}
function catLabel(c) { return { SHARE: "Aktien", FUND: "Fonds/ETF", OPTION: "Optionen", OTHER: "Krypto/Andere", BOND: "Obligationen", COINBULL: "Edelmetalle" }[c] || c; }
function barChart(rows) {
  if (!rows.length) return '<p class="muted-note">Keine Daten (Steuerwerte kommen aus der Kursliste).</p>';
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return '<div class="chart">' + rows.map((r) => {
    const w = Math.max(2, (Math.abs(r.value) / max) * 100);
    return `<div class="bar-row"><div class="name" title="${esc(r.name)}">${esc(r.name)}</div><div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div><div class="val">${chf(r.value)}</div></div>`;
  }).join("") + "</div>";
}
function mini(label, value) { return `<div class="field"><label>${esc(label)}</label><div style="font-size:20px;font-weight:700">${value}</div></div>`; }
function dashboardHtml(s) {
  const income = (s.dividenden.grossChf || 0) + (s.bankInterestChf || 0);
  const kpis = '<div class="kpis" style="margin-bottom:20px">' +
    kpi("accent-1", "Zugänge (Käufe)", num(s.zugaenge.count), "Volumen " + chf(s.zugaenge.totalChf)) +
    kpi("accent-2", "Abgänge (Verkäufe)", num(s.abgaenge.count), "Volumen " + chf(s.abgaenge.totalChf)) +
    kpi("accent-3", "Dividenden & Erträge", chf(income), num(s.dividenden.count) + " Zahlungen") +
    kpi("accent-4", "Verrechnungssteuer", chf(s.dividenden.swissWhtChf), "rückforderbar (CH)") + "</div>";
  const summaryCard = '<div class="card"><h2>Übersicht ' + esc(s.taxYear) + '</h2><div class="grid3">' +
    mini("Positionen per 31.12.", num(s.positions.filter((p) => p.closingQty !== 0).length)) +
    mini("Instrumente", num(s.positions.length)) +
    mini("Geschätzter Depotwert", chf(s.portfolioChf)) +
    mini("Dividenden brutto", chf(s.dividenden.grossChf)) +
    mini("Ausländische Quellensteuer", chf(s.dividenden.foreignWhtChf)) +
    mini("Zinsen auf Konten", chf(s.bankInterestChf)) + "</div></div>";
  const cash = s.cash && s.cash.length ? '<div class="card"><h2>Kontostände per 31.12.</h2><div class="table-wrap"><table><thead><tr><th>Währung</th><th class=num>Saldo</th><th class=num>Wert CHF</th></tr></thead><tbody>' +
    s.cash.map((b) => `<tr><td>${esc(b.currency)}</td><td class=num>${num(b.amount, 2)} ${esc(b.currency)}</td><td class=num>${chf(b.amountChf)}</td></tr>`).join("") +
    `<tr><td><strong>Total</strong></td><td></td><td class=num><strong>${chf(s.cashTotalChf)}</strong></td></tr></tbody></table></div></div>` : "";
  const catRows = s.categoryValue.filter((c) => c.valueChf > 0).map((c) => ({ name: catLabel(c.category), value: c.valueChf }));
  const charts = '<div class="card"><h2>Geschätzter Depotwert nach Kategorie</h2><p class="hint">Nach letztem Transaktionskurs · nur Schätzung</p>' + barChart(catRows) + '</div>';
  const div = s.dividenden.top.length ? '<div class="card"><h2>Grösste Dividenden & Erträge</h2><div class="table-wrap"><table><thead><tr><th>Datum</th><th>Titel</th><th class=num>Brutto</th><th class=num>Netto</th><th>CH</th></tr></thead><tbody>' +
    s.dividenden.top.map((i) => `<tr><td>${esc(i.date)}</td><td title="${esc(i.name)}">${esc(i.name.length > 30 ? i.name.slice(0, 29) + "…" : i.name)}</td><td class=num>${num(i.gross, 2)} ${esc(i.currency)}</td><td class=num>${num(i.net, 2)}</td><td>${i.swiss ? '<span class="tag">CH</span>' : ""}</td></tr>`).join("") + "</tbody></table></div></div>" : "";
  return kpis + summaryCard + cash + charts + div;
}
