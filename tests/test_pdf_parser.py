from decimal import Decimal

import pytest

from backend.pdf_parser import parse_kontoauszug
from tests.conftest import ROOT

SAMPLE_PDF = ROOT / "sample_data" / "sample_kontoauszug.pdf"


@pytest.fixture
def konto():
    return parse_kontoauszug(SAMPLE_PDF.read_bytes())


def test_identity_extracted(konto):
    assert konto.account.holder_name == "Max Muster"
    assert konto.account.customer_number == "9999999"
    assert konto.account.iban.startswith("CH")


def test_year_end_balances(konto):
    bal = {b.currency: b.amount for b in konto.balances}
    assert bal["CHF"] == Decimal("1234.50")
    assert bal["USD"] == Decimal("500.00")
    assert bal["XAU"] == Decimal("2.00")


def test_transactions_parsed(konto):
    types = {t.type for t in konto.transactions}
    assert "Kauf" in types and "Dividende" in types


def test_dividend_isin_backfilled_from_trade(konto):
    # The dividend row has no ISIN line; it must inherit CH0038863350 from the buy.
    div = next(t for t in konto.transactions if t.type == "Dividende")
    assert div.isin == "CH0038863350"
    assert div.quantity == Decimal("5")


def test_dividend_gross_uses_betrag(konto):
    # gross = net + costs = 25.77 + 13.88 = 39.65 (Betrag), withholding 13.88.
    div = next(t for t in konto.transactions if t.type == "Dividende")
    assert div.net_amount == Decimal("25.77")
    assert div.costs == Decimal("13.88")


def test_rejects_non_kontoauszug_pdf():
    from backend.csv_parser import CsvParseError

    # A minimal PDF that isn't a Swissquote statement.
    import fitz

    d = fitz.open()
    d.new_page()
    with pytest.raises(CsvParseError):
        parse_kontoauszug(d.tobytes())
