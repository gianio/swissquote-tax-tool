from decimal import Decimal

import pytest

from backend.classifier import classify
from backend.csv_parser import parse_transactions
from tests.conftest import SAMPLE_CSV


@pytest.fixture
def result():
    return classify(parse_transactions(SAMPLE_CSV.read_bytes()))


def test_card_transactions_are_not_securities(result):
    names = [i.name for i in result.instruments]
    assert "COFFEE SHOP" not in names
    assert result.ignored_cash  # card spending lands here


def test_cash_interest_is_separated(result):
    assert len(result.cash_interest) == 1
    assert result.cash_interest[0].currency == "CHF"


def test_nestle_position_reconstructed(result):
    nesn = next(i for i in result.instruments if i.isin == "CH0038863350")
    # Bought 100, sold 99 within the year -> closing 1, no inferred opening.
    assert nesn.closing_quantity == Decimal("1")
    assert nesn.opening_inferred is False
    assert nesn.country == "CH"
    assert nesn.category == "SHARE"


def test_inferred_opening_for_pre_year_holding():
    # A pure sell with no prior buy must infer an opening balance.
    from backend.csv_parser import parse_transactions as ppt
    csv = (
        "Datum;Auftrag #;Transaktionen;Symbol;Name;ISIN;Anzahl;Stückpreis;Kosten;"
        "Aufgelaufene Zinsen;Nettobetrag;Saldo;Währung\r\n"
        "13-01-2025 15:30:08;211814754;Verkauf;TSLA;\"TESLA ORD\";US88160R1014;"
        "1.0;383.26;3.58;0.00;379.68;383.66;USD\r\n"
    ).encode("latin-1")
    res = classify(ppt(csv))
    tsla = next(i for i in res.instruments if i.isin == "US88160R1014")
    assert tsla.opening_quantity == Decimal("1")
    assert tsla.opening_inferred is True
    assert tsla.closing_quantity == Decimal("0")


def test_crypto_and_option_detection(result):
    btc = next(i for i in result.instruments if i.symbol == "BTC")
    assert btc.is_crypto and btc.isin is None and btc.category == "OTHER"
    opt = next(i for i in result.instruments if i.is_option)
    assert opt.category == "OPTION" and opt.isin is None


def test_swiss_vs_foreign_dividend_currency(result):
    vgit = next(i for i in result.instruments if i.isin == "US92206C7065")
    assert vgit.country == "US"
    assert len(vgit.income) == 1
