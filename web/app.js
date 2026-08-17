"use strict";
// Browser glue for the browser-only PoC. All work happens client-side via SQCore.

const $ = (id) => document.getElementById(id);
const CANTONS = ["ZH","BE","LU","UR","SZ","OW","NW","GL","ZG","FR","SO","BS","BL","SH","AR","AI","SG","GR","AG","TG","TI","VD","VS","NE","GE","JU"];
const DEFAULT_FX = { USD:"0.80", EUR:"0.93", CAD:"0.58", DKK:"0.125", GBP:"1.08", XAU:"3400" };

let txns = null, currencies = [], lastXml = null;

const chf = (n) => new Intl.NumberFormat("de-CH",{style:"currency",currency:"CHF"}).format(n||0);
const esc = (s) => String(s==null?"":s).replace(/[&<>]/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));

$("themeToggle").addEventListener("click", () => {
  const root = document.documentElement, cur = root.getAttribute("data-theme");
  const dark = cur ? cur === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", dark ? "light" : "dark");
});

const dz = $("dropzone"), fi = $("fileInput");
dz.addEventListener("click", () => fi.click());
dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
dz.addEventListener("drop", (e) => { e.preventDefault(); dz.classList.remove("drag"); if (e.dataTransfer.files[0]) loadFile(e.dataTransfer.files[0]); });
fi.addEventListener("change", () => { if (fi.files[0]) loadFile(fi.files[0]); });

async function loadFile(file) {
  $("err").hidden = true;
  try {
    // Swissquote CSV is Latin-1 (ISO-8859-1).
    const buf = await file.arrayBuffer();
    const text = new TextDecoder("iso-8859-1").decode(buf);
    txns = SQCore.parseCsv(text);
    $("fileName").textContent = "✓ " + file.name + " (" + txns.length + " Transaktionen)";
    $("fileName").hidden = false;
    setupForm();
    $("formCard").hidden = false;
    $("formCard").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    const el = $("err"); el.textContent = e.message; el.hidden = false;
  }
}

function setupForm() {
  const years = new Set(txns.map((t) => Math.floor(t.dateKey / 10000)));
  const y = [...years].sort().reverse()[0] || new Date().getFullYear() - 1;
  const yopts = [];
  for (let yr = y + 1; yr >= y - 6; yr--) yopts.push(yr);
  $("f_year").innerHTML = yopts.map((yr) => `<option value="${yr}"${yr===y?" selected":""}>${yr}</option>`).join("");
  $("f_canton").innerHTML = CANTONS.map((c) => `<option>${c}</option>`).join("");

  currencies = [...new Set(txns.map((t) => t.currency).filter((c) => c && c !== "CHF"))].sort();
  $("fxGrid").innerHTML = currencies.length
    ? currencies.map((c) => `<div class="field"><label>1 ${c} = … CHF</label><input class="fx" data-ccy="${c}" type="number" step="0.0001" value="${DEFAULT_FX[c]||"1"}"></div>`).join("")
    : '<p class="muted-note">Alle Beträge in CHF.</p>';
}

function collectCfg() {
  const fx = { CHF: 1 };
  document.querySelectorAll(".fx").forEach((i) => (fx[i.dataset.ccy] = Number(i.value) || 1));
  return {
    taxYear: Number($("f_year").value),
    canton: $("f_canton").value,
    firstName: $("f_first").value.trim(),
    lastName: $("f_last").value.trim(),
    clientNumber: $("f_client").value.trim(),
    taxValueMode: $("f_taxmode").value,
    fxRates: fx,
  };
}

$("genBtn").addEventListener("click", () => {
  try {
    const res = SQCore.classify(txns, "CH");
    const out = SQCore.buildXml(res, collectCfg());
    lastXml = out.xml;
    const wellFormed = !new DOMParser().parseFromString(out.xml, "application/xml").querySelector("parsererror");
    $("badge").innerHTML = wellFormed
      ? '<span class="badge ok">✓ eCH‑0196 v2.2 erzeugt (im Browser)</span>'
      : '<span class="badge bad">✗ XML‑Fehler</span>';
    const t = out.totals;
    $("kpis").innerHTML =
      kpi("accent-1", "Positionen", out.securitiesCount) +
      kpi("accent-3", "Ertrag A (CH)", chf(t.grossA)) +
      kpi("accent-2", "Ertrag B (Ausland)", chf(t.grossB)) +
      kpi("accent-4", "Verrechnungssteuer", chf(t.wht));
    $("xmlPreview").textContent = out.xml.length > 6000 ? out.xml.slice(0, 6000) + "\n…" : out.xml;
    $("resultCard").hidden = false;
    $("resultCard").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    const el = $("err"); el.textContent = e.message; el.hidden = false;
  }
});

$("dlBtn").addEventListener("click", () => {
  if (!lastXml) return;
  const blob = new Blob([lastXml], { type: "application/xml" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `eCH-0196_Swissquote_${$("f_year").value}.xml`;
  a.click();
  URL.revokeObjectURL(a.href);
});

function kpi(cls, label, value) {
  return `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;
}
