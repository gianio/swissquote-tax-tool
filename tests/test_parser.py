from datetime import date
from decimal import Decimal

import pytest

from backend.csv_parser import CsvParseError, infer_tax_year, parse_transactions
from tests.conftest import SAMPLE_CSV


@pytest.fixture
def transactions():
    return parse_transactions(SAMPLE_CSV.read_bytes())


def test_parses_all_rows(transactions):
    assert len(transactions) == 10


def test_latin1_umlaut_in_header_is_handled(transactions):
    # A dividend row must expose the correct currency and amounts.
    nesn = next(t for t in transactions if t.type == "Dividende" and t.symbol == "NESN")
    assert nesn.currency == "CHF"
    assert nesn.unit_price == Decimal("39.65")
    assert nesn.costs == Decimal("13.88")


def test_dates_and_types(transactions):
    types = {t.type for t in transactions}
    assert {"Kauf", "Verkauf", "Dividende", "Buy-to-Open", "Expiration",
            "Kartentransaktion", "Zinsen auf Einlagen"} <= types
    assert any(t.date == date(2025, 4, 24) for t in transactions)


def test_blank_amount_dash_is_none(transactions):
    exp = next(t for t in transactions if t.type == "Expiration")
    assert exp.net_amount is None       # exported as "-"
    assert exp.unit_price == Decimal("0")


def test_infer_tax_year(transactions):
    assert infer_tax_year(transactions) == 2025


def test_rejects_non_swissquote_file():
    with pytest.raises(CsvParseError):
        parse_transactions(b"foo,bar,baz\n1,2,3\n")


def test_rejects_empty_file():
    with pytest.raises(CsvParseError):
        parse_transactions(b"")
