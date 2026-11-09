"""The bank-agnostic browser importer must produce XSD-valid eCH-0196 XML.

Runs web/importers.js + web/core.js through Node, like test_web_poc.py.
Skipped if Node isn't installed.
"""

import json
import shutil
import subprocess

import pytest

from backend.validation import validate_ech0196
from tests.conftest import ROOT

node = shutil.which("node")
pytestmark = pytest.mark.skipif(node is None, reason="Node.js not available")

CLI = ROOT / "web" / "cli.js"
GENERIC_CSV = ROOT / "sample_data" / "sample_generic_bank.csv"


def _node(script: str) -> str:
    return subprocess.run([node, "-e", script], capture_output=True, check=True, cwd=ROOT, text=True).stdout


def test_generic_bank_csv_is_xsd_valid():
    xml = subprocess.run([node, str(CLI), str(GENERIC_CSV), "2025", "BE"], capture_output=True, check=True).stdout
    result = validate_ech0196(xml)
    assert result.valid, result.errors[:10]
    text = xml.decode()
    assert 'canton="BE"' in text
    # Nestlé: bought 20, sold 5 -> 15 at year end; preamble lines skipped,
    # comma decimals and "1'912,00" thousands parsed.
    assert 'isin="CH0038863350"' in text
    assert 'quantity="15" balanceCurrency="CHF" name="Bestand 31.12."' in text


def test_number_and_date_parsing():
    out = json.loads(_node("""
      const I=require('./web/importers.js');
      console.log(JSON.stringify({
        a:I.parseNumber("1'234.50","."), b:I.parseNumber("1.234,50",","), c:I.parseNumber("(12.5)","."),
        d:I.parseNumber("100.00-","."), e:I.parseDate("31.12.2025","DMY").iso, f:I.parseDate("12/31/2025","MDY").iso,
        g:I.parseDate("2025-03-04").iso, h:I.parseDate("4 Mär 2025").iso,
        t1:I.guessType("Verkauf",true), t2:I.guessType("Kauf",true), t3:I.guessType("Zins",true), t4:I.guessType("Zins",false)
      }));"""))
    assert out["a"] == 1234.5 and out["b"] == 1234.5 and out["c"] == -12.5 and out["d"] == -100
    assert out["e"] == "2025-12-31" and out["f"] == "2025-12-31" and out["g"] == "2025-03-04" and out["h"] == "2025-03-04"
    assert out["t1"] == "Verkauf" and out["t2"] == "Kauf"
    assert out["t3"] == "Dividende" and out["t4"] == "Zinsen auf Einlagen"


def test_manual_year_end_holding_and_cash():
    xml = _node("""
      const I=require('./web/importers.js'), C=require('./web/core.js');
      const r=I.fromManual([
        {type:'Bestand 31.12.',date:'31.12.2025',isin:'CH0012221716',name:'ABB Ltd',quantity:'10'},
        {type:'Dividende',date:'05.05.2025',isin:'CH0012221716',name:'ABB Ltd',net:'5.85',costs:'3.15'},
        {type:'Kontostand 31.12.',date:'31.12.2025',net:'2500',currency:'CHF'}],'CHF');
      const res=C.classify(r.txns,'CH');
      process.stdout.write(C.buildXml(res,{taxYear:2025,canton:'ZH',clientNumber:'1',cashBalances:r.balances,fxRates:{CHF:1}}).xml);""")
    result = validate_ech0196(xml.encode())
    assert result.valid, result.errors[:10]
    # No trades: opening == closing == 10 (not inferred), dividend gross 9.00 as revenue A.
    assert 'quantity="10" balanceCurrency="CHF" name="Bestand 01.01."' in xml
    assert 'grossRevenueA="9"' in xml
    assert 'balance="2500"' in xml
