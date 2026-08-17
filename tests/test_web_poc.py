"""The browser-only PoC must generate XSD-valid eCH-0196 XML.

We run the JavaScript core (web/core.js) through Node exactly as the browser
would, then validate its output against the official schema. This guards the
client-side path against regressions. Skipped if Node isn't installed.
"""

import shutil
import subprocess

import pytest

from backend.validation import validate_ech0196
from tests.conftest import ROOT, SAMPLE_CSV

CLI = ROOT / "web" / "cli.js"
node = shutil.which("node")

pytestmark = pytest.mark.skipif(node is None, reason="Node.js not available")


def _run(year=2025, canton="GR") -> bytes:
    proc = subprocess.run(
        [node, str(CLI), str(SAMPLE_CSV), str(year), canton],
        capture_output=True, check=True,
    )
    return proc.stdout


def test_browser_core_produces_xsd_valid_xml():
    xml = _run()
    assert xml.startswith(b"<?xml")
    result = validate_ech0196(xml)
    assert result.valid, result.errors[:10]


def test_browser_core_emits_swiss_valor():
    # Nestlé (CH0038863350) is in the sample CSV → valor 3886335 must be present.
    assert b'valorNumber="3886335"' in _run()


def test_browser_core_minimal_tax_value_total_zero():
    xml = _run().decode()
    # Minimal mode: securities tax value is undefined, so the declared total is 0.
    import re
    m = re.search(r'<listOfSecurities totalTaxValue="([^"]+)"', xml)
    assert m and m.group(1) == "0"
