from decimal import Decimal

import pytest

from backend.carryforward import (OpeningPosition, parse_carry_forward,
                                  valid_isin, valor_from_isin)
from backend.classifier import classify
from backend.config import StatementConfig
from backend.csv_parser import parse_transactions
from backend.statement_builder import build_statement
from backend.validation import validate_ech0196
from tests.conftest import SAMPLE_CSV


def test_valid_isin_filters_ibans():
    assert valid_isin("CH0038863350")     # Nestlé
    assert valid_isin("US0378331005")     # Apple
    # IBAN fragment that matches the loose pattern but isn't a security.
    assert not valid_isin("CH1908781000")
    assert not valid_isin("")


def test_valor_from_swiss_isin():
    assert valor_from_isin("CH0012214059") == 1221405
    assert valor_from_isin("US0378331005") is None


def _sample_statement_xml():
    res = classify(parse_transactions(SAMPLE_CSV.read_bytes()))
    stmt, _ = build_statement(res, StatementConfig(tax_year=2025, canton="GR", client_number="1"))
    return stmt.to_xml_bytes()


def test_parse_ech_xml_round_trip():
    positions = parse_carry_forward(_sample_statement_xml(), "prev.xml")
    by_isin = {p.isin: p for p in positions if p.isin}
    # Nestlé held 1 at year-end in the sample (bought 100, sold 99).
    assert "CH0038863350" in by_isin
    nesn = by_isin["CH0038863350"]
    assert nesn.quantity == Decimal("1")
    assert nesn.valor == 3886335


def test_carry_forward_sets_opening_and_binds():
    res = classify(parse_transactions(SAMPLE_CSV.read_bytes()))
    # Pretend last year closed with 100 Nestlé and give a foreign valor.
    opening = [
        OpeningPosition(isin="CH0038863350", quantity=Decimal("100"), valor=3886335),
        OpeningPosition(isin="US92826C8394", quantity=Decimal("5"), valor=1234567),
    ]
    cfg = StatementConfig(tax_year=2025, canton="GR", client_number="1")
    stmt, report = build_statement(res, cfg, opening_positions=opening)
    assert report.carried_count >= 1
    xml = stmt.to_xml_bytes().decode()
    # Nestlé opening balance is now 100 and flagged as carried from last year.
    assert 'quantity="100" balanceCurrency="CHF" name="Bestand 01.01.  (Vorjahr)"' in xml
    # The supplied foreign valor is emitted so softax can bind the title.
    assert 'valorNumber="1234567"' in xml
    assert validate_ech0196(stmt.to_xml_bytes()).valid


def test_opening_positions_accepts_dicts():
    res = classify(parse_transactions(SAMPLE_CSV.read_bytes()))
    stmt, report = build_statement(
        res, StatementConfig(tax_year=2025, client_number="1"),
        opening_positions=[{"isin": "CH0038863350", "quantity": "50"}],
    )
    assert report.carried_count == 1
