"use strict";
// Browser-only app glue. All processing is client-side (SQCore + SQPdf); the
// PDF worker is the vendored pdf.js file — no network, no server.
pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";

const $ = (id) => document.getElementById(id);
const CANTONS = ["ZH","BE","LU","UR","SZ","OW","NW","GL","ZG","FR","SO","BS","BL","SH","AR","AI","SG","GR","AG","TG","TI","VD","VS","NE","GE","JU"];
const DEFAULT_FX = { USD:"0.80", EUR:"0.93", CAD:"0.58", DKK:"0.125", GBP:"1.08", XAU:"3400" };
const MONTHS = ["Jan","Feb","Mär","Apr","Mai","Jun","Jul","Aug","Sep","Okt","Nov","Dez"];

let txns = null, cashBalances = [], account = {}, currencies = [], lastXml = null, lastYear = 2025;

const chf = (n) => new Intl.NumberFormat("de-CH",{style:"currency",currency:"CHF",maximumFractionDigits:2}).format(n||0);
const num = (n,d=0) => new Intl.NumberFormat("de-CH",{minimumFractionDigits:d,maximumFractionDigits:d}).format(n||0);
const esc = (s) => String(s==null?"":s).replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));

$("themeToggle").addEventListener("click", () => {
  const root=document.documentElement, cur=root.getAttribute("data-theme");
  const dark = cur ? cur==="dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  root.setAttribute("data-theme", dark?"light":"dark");
});

const dz=$("dropzone"), fi=$("fileInput");
dz.addEventListener("click",()=>fi.click());
dz.addEventListener("dragover",(e)=>{e.preventDefault();dz.classList.add("drag");});
dz.addEventListener("dragleave",()=>dz.classList.remove("drag"));
dz.addEventListener("drop",(e)=>{e.preventDefault();dz.classList.remove("drag");if(e.dataTransfer.files[0])loadFile(e.dataTransfer.files[0]);});
fi.addEventListener("change",()=>{if(fi.files[0])loadFile(fi.files[0]);});

async function loadFile(file){
  $("err").hidden=true; cashBalances=[]; account={};
  $("parseStatus").textContent="Verarbeite lokal …";
  try{
    const buf = await file.arrayBuffer();
    const isPdf = new Uint8Array(buf.slice(0,5)).reduce((s,b)=>s+String.fromCharCode(b),"")==="%PDF-" || /\.pdf$/i.test(file.name);
    if(isPdf){
      const k = await SQPdf.parseKontoauszug(buf, pdfjsLib);
      txns = k.transactions; cashBalances = k.balances; account = k.account;
      $("parseStatus").textContent = `✓ PDF gelesen: ${txns.length} Transaktionen, ${k.balances.length} Kontostände`;
    } else {
      const text = new TextDecoder("iso-8859-1").decode(buf);
      txns = SQCore.parseCsv(text);
      $("parseStatus").textContent = `✓ CSV gelesen: ${txns.length} Transaktionen`;
    }
    $("fileName").textContent="✓ "+file.name; $("fileName").hidden=false;
    setupForm();
    $("formCard").hidden=false; $("formCard").scrollIntoView({behavior:"smooth"});
  }catch(e){ const el=$("err"); el.textContent=e.message; el.hidden=false; $("parseStatus").textContent=""; }
}

function setupForm(){
  const years=new Set(txns.map((t)=>Math.floor(t.dateKey/10000)));
  const y=[...years].sort().reverse()[0]||new Date().getFullYear()-1; lastYear=y;
  const yo=[]; for(let yr=y+1;yr>=y-6;yr--)yo.push(yr);
  $("f_year").innerHTML=yo.map((yr)=>`<option value="${yr}"${yr===y?" selected":""}>${yr}</option>`).join("");
  $("f_canton").innerHTML=CANTONS.map((c)=>`<option>${c}</option>`).join("");
  if(account.holderName){const p=account.holderName.split(" ");$("f_first").value=p.slice(0,-1).join(" ");$("f_last").value=p[p.length-1];}
  if(account.customerNumber)$("f_client").value=account.customerNumber;

  const ccyset=new Set(txns.map((t)=>t.currency).filter((c)=>c&&c!=="CHF"));
  cashBalances.forEach((b)=>{if(b.currency&&b.currency!=="CHF")ccyset.add(b.currency);});
  currencies=[...ccyset].sort();
  $("fxGrid").innerHTML=currencies.length
    ? currencies.map((c)=>`<div class="field"><label>1 ${c} = … CHF</label><input class="fx" data-ccy="${c}" type="number" step="0.0001" value="${DEFAULT_FX[c]||"1"}"></div>`).join("")
    : '<p class="muted-note">Alle Beträge in CHF.</p>';
}

function collectCfg(){
  const fx={CHF:1};
  document.querySelectorAll(".fx").forEach((i)=>fx[i.dataset.ccy]=Number(i.value)||1);
  return { taxYear:Number($("f_year").value), canton:$("f_canton").value,
    firstName:$("f_first").value.trim(), lastName:$("f_last").value.trim(),
    clientNumber:$("f_client").value.trim(), taxValueMode:$("f_taxmode").value,
    fxRates:fx, cashBalances, openingPositions:collectCarry() };
}

// ---- carry-forward -------------------------------------------------------
$("cfBtn").addEventListener("click",()=>$("cfInput").click());
$("cfInput").addEventListener("change", async ()=>{
  const file=$("cfInput").files[0]; if(!file)return;
  $("cfStatus").textContent="Lese Positionen …";
  try{
    const buf=await file.arrayBuffer();
    const positions=await SQCarry.parse(buf, file.name, pdfjsLib);
    renderCarryTable(positions);
    const withQ=positions.filter((p)=>p.quantity!=="").length;
    $("cfStatus").textContent=`✓ ${positions.length} Positionen (${withQ} mit Bestand) – bitte prüfen.`;
  }catch(e){ $("cfStatus").textContent="⚠ "+e.message; }
});
function renderCarryTable(positions){
  if(!positions.length){$("cfTableHost").innerHTML="";return;}
  const rows=positions.map((p)=>`<tr>
    <td><input class="cf-isin" value="${esc(p.isin)}" style="width:118px"></td>
    <td title="${esc(p.name)}">${esc(p.name.length>24?p.name.slice(0,23)+"…":p.name)}</td>
    <td><input class="cf-valor" value="${esc(p.valor??"")}" style="width:92px" placeholder="—"></td>
    <td><input class="cf-qty" value="${esc(p.quantity)}" style="width:78px" placeholder="Bestand"></td></tr>`).join("");
  $("cfTableHost").innerHTML='<div class="banner info" style="margin-bottom:8px"><span class="ico">↪</span><div>Anfangsbestand (01.01.) je Titel – aus der Datei vorausgefüllt. Menge/Valor prüfen; leere Bestände werden ignoriert.</div></div>'+
    '<div class="table-wrap"><table><thead><tr><th>ISIN</th><th>Titel</th><th>Valor</th><th>Bestand 01.01.</th></tr></thead><tbody>'+rows+'</tbody></table></div>';
}
function collectCarry(){
  const host=$("cfTableHost"); if(!host||!host.querySelector("table"))return [];
  const out=[];
  host.querySelectorAll("tbody tr").forEach((tr)=>{
    const isin=tr.querySelector(".cf-isin").value.trim();
    const valor=tr.querySelector(".cf-valor").value.trim();
    const qty=tr.querySelector(".cf-qty").value.trim();
    if(isin)out.push({isin,valor:valor||null,quantity:qty||""});
  });
  return out;
}

$("genBtn").addEventListener("click",()=>{
  try{
    const cfg=collectCfg();
    const res=SQCore.classify(txns,"CH");
    const out=SQCore.buildXml(res,cfg);
    const sum=SQCore.summarize(res,cfg,cashBalances);
    lastXml=out.xml;
    const wf=!new DOMParser().parseFromString(out.xml,"application/xml").querySelector("parsererror");
    $("badge").innerHTML= (wf
      ? '<span class="badge ok">✓ eCH‑0196 v2.2 erzeugt (im Browser)</span>'
      : '<span class="badge bad">✗ XML‑Fehler</span>')
      + (out.carriedCount ? ` <span class="badge ok" style="background:color-mix(in srgb,var(--good) 12%,transparent)">↪ ${out.carriedCount} aus Vorjahr weitergeführt</span>` : "");
    $("resultCard").hidden=false;
    $("dashboardHost").innerHTML=dashboardHtml(sum);
    $("resultCard").scrollIntoView({behavior:"smooth"});
  }catch(e){ const el=$("err"); el.textContent=e.message; el.hidden=false; }
});

$("dlBtn").addEventListener("click",()=>{
  if(!lastXml)return;
  download(new Blob([lastXml],{type:"application/xml"}), `eCH-0196_Swissquote_${$("f_year").value}.xml`);
});

$("dlPdfBtn").addEventListener("click", async ()=>{
  if(!lastXml)return;
  const btn=$("dlPdfBtn"), orig=btn.textContent; btn.disabled=true;
  const setP=(m)=>{$("pdfStatus").textContent=m;};
  btn.innerHTML='<span class="spinner"></span> Erzeuge …';
  try{
    const idM=lastXml.match(/\bid="([^"]+)"/);
    const y=Number($("f_year").value);
    const creationTs=Date.UTC(y,11,31,12,0,0)/1000;
    const pdfBytes=await SQBarcode.generate(lastXml,{statementId:idM?idM[1]:"STATEMENT",creationTs,taxYear:y},setP);
    download(new Blob([pdfBytes],{type:"application/pdf"}), `eCH-0196_Swissquote_${y}.pdf`);
    setP("✓ Barcode‑PDF erzeugt.");
  }catch(e){ setP("⚠ "+e.message); }
  finally{ btn.disabled=false; btn.textContent=orig; }
});

function download(blob, name){
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob);
  a.download=name; a.click(); URL.revokeObjectURL(a.href);
}

// ---- dashboard -----------------------------------------------------------
function kpi(cls,label,value,foot){
  return `<div class="kpi ${cls}"><div class="label">${esc(label)}</div><div class="value">${value}</div>${foot?`<div class="foot">${esc(foot)}</div>`:""}</div>`;
}
function catLabel(c){return {SHARE:"Aktien",FUND:"Fonds/ETF",OPTION:"Optionen",OTHER:"Krypto/Andere",BOND:"Obligationen",COINBULL:"Edelmetalle"}[c]||c;}
function barChart(rows){
  if(!rows.length)return '<p class="muted-note">Keine Daten.</p>';
  const max=Math.max(...rows.map((r)=>Math.abs(r.value)),1);
  return '<div class="chart">'+rows.map((r)=>{
    const w=Math.max(2,(Math.abs(r.value)/max)*100);
    return `<div class="bar-row"><div class="name" title="${esc(r.name)}">${esc(r.name)}</div><div class="bar-track"><div class="bar-fill" style="width:${w}%"></div></div><div class="val">${chf(r.value)}</div></div>`;
  }).join("")+"</div>";
}
function dashboardHtml(s){
  const income=(s.dividenden.grossChf||0)+(s.bankInterestChf||0);
  const kpis='<div class="kpis" style="margin-bottom:20px">'+
    kpi("accent-1","Zugänge (Käufe)",num(s.zugaenge.count),"Volumen "+chf(s.zugaenge.totalChf))+
    kpi("accent-2","Abgänge (Verkäufe)",num(s.abgaenge.count),"Volumen "+chf(s.abgaenge.totalChf))+
    kpi("accent-3","Dividenden & Erträge",chf(income),num(s.dividenden.count)+" Zahlungen")+
    kpi("accent-4","Verrechnungssteuer",chf(s.dividenden.swissWhtChf),"rückforderbar (CH)")+"</div>";

  const summaryCard='<div class="card"><h2>Zusammenfassung '+esc(s.taxYear)+'</h2><div class="grid3">'+
    mini("Positionen per 31.12.",num(s.positions.filter((p)=>p.closingQty!==0).length))+
    mini("Gehandelte Instrumente",num(s.positions.length))+
    mini("Geschätzter Steuerwert",chf(s.portfolioChf))+
    mini("Dividenden brutto",chf(s.dividenden.grossChf))+
    mini("Ausländische Quellensteuer",chf(s.dividenden.foreignWhtChf))+
    mini("Zinsen auf Einlagen",chf(s.bankInterestChf))+"</div></div>";

  const cash=s.cash&&s.cash.length ? '<div class="card"><h2>Kontostände per 31.12.</h2><div class="table-wrap"><table><thead><tr><th>Währung</th><th class=num>Saldo</th><th class=num>Wert CHF</th></tr></thead><tbody>'+
    s.cash.map((b)=>`<tr><td>${esc(b.currency)}</td><td class=num>${num(b.amount,2)} ${esc(b.currency)}</td><td class=num>${chf(b.amountChf)}</td></tr>`).join("")+
    `<tr><td><strong>Total</strong></td><td></td><td class=num><strong>${chf(s.cashTotalChf)}</strong></td></tr></tbody></table></div></div>` : "";

  const catRows=s.categoryValue.filter((c)=>c.valueChf>0).map((c)=>({name:catLabel(c.category),value:c.valueChf}));
  const charts='<div class="card"><h2>Geschätzter Depotwert nach Kategorie</h2><p class="hint">Nach letztem Handelskurs · Schätzung</p>'+barChart(catRows)+'</div>';

  const div=s.dividenden.top.length ? '<div class="card"><h2>Grösste Dividenden & Erträge</h2><div class="table-wrap"><table><thead><tr><th>Datum</th><th>Titel</th><th class=num>Brutto</th><th class=num>Netto</th><th>CH</th></tr></thead><tbody>'+
    s.dividenden.top.map((i)=>`<tr><td>${esc(i.date)}</td><td title="${esc(i.name)}">${esc(i.name.length>30?i.name.slice(0,29)+"…":i.name)}</td><td class=num>${num(i.gross,2)} ${esc(i.currency)}</td><td class=num>${num(i.net,2)}</td><td>${i.swiss?'<span class="tag">CH</span>':""}</td></tr>`).join("")+"</tbody></table></div></div>" : "";

  const held=s.positions.filter((p)=>p.closingQty!==0);
  const pos=held.length ? '<div class="card"><h2>Rekonstruierte Bestände per 31.12.</h2><div class="table-wrap"><table><thead><tr><th>Titel</th><th>ISIN</th><th>Kat.</th><th class=num>Bestand</th><th class=num>Steuerwert (Schätz.)</th></tr></thead><tbody>'+
    held.map((p)=>`<tr><td title="${esc(p.name)}">${esc(p.name.length>30?p.name.slice(0,29)+"…":p.name)}${p.openingInferred?' <span class="tag est">rekonstr.</span>':""}</td><td>${esc(p.isin||"—")}</td><td>${esc(catLabel(p.category))}</td><td class=num>${num(p.closingQty,p.closingQty%1?4:0)} ${esc(p.currency)}</td><td class=num>${chf(p.taxValueChf)}</td></tr>`).join("")+"</tbody></table></div></div>" : "";

  return kpis+summaryCard+cash+charts+div+pos;
}
function mini(label,value){return `<div class="field"><label>${esc(label)}</label><div style="font-size:20px;font-weight:700">${value}</div></div>`;}
