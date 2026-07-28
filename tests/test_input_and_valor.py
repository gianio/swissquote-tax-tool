from decimal import Decimal

from backend.classifier import classify
from backend.config import StatementConfig
from backend.input_parser import parse_input, split_name
from backend.pdf_parser import CashBalance
from backend.statement_builder import _valor_from_isin, build_statement
from backend.validation import validate_ech0196
from tests.conftest import ROOT, SAMPLE_CSV

SAMPLE_PDF = ROOT / "sample_data" / "sample_kontoauszug.pdf"


def test_parse_input_detects_csv():
    parsed = parse_input(SAMPLE_CSV.read_bytes(), "sample.csv")
    assert parsed.source == "csv"
    assert parsed.transactions and not parsed.cash_balances


def test_parse_input_detects_pdf():
    parsed = parse_input(SAMPLE_PDF.read_bytes(), "konto.pdf")
    assert parsed.source == "pdf"
    assert parsed.cash_balances
    assert parsed.account.customer_number == "9999999"


def test_split_name():
    assert split_name("Gian-Andri Morf") == ("Gian-Andri", "Morf")
    assert split_name("Max Muster") == ("Max", "Muster")
    assert split_name("") == ("", "")


def test_valor_derived_from_swiss_isin():
    assert _valor_from_isin("CH0038863350") == 3886335   # Nestlé
    assert _valor_from_isin("CH0012214059") == 1221405   # Holcim
    # Foreign ISINs have no derivable Swiss valor.
    assert _valor_from_isin("US0378331005") is None
    assert _valor_from_isin(None) is None


def test_cash_balances_become_bank_accounts():
    result = classify(parse_input(SAMPLE_CSV.read_bytes()).transactions)
    balances = [CashBalance("CHF", Decimal("1000")), CashBalance("USD", Decimal("500")),
                CashBalance("XAU", Decimal("2"))]
    cfg = StatementConfig(tax_year=2025, canton="GR", client_number="1",
                          fx_rates={"CHF": Decimal("1"), "USD": Decimal("0.8"), "XAU": Decimal("3400")})
    statement, report = build_statement(result, cfg, cash_balances=balances)
    accounts = statement.listOfBankAccounts.bankAccount
    currencies = {a.bankAccountCurrency for a in accounts}
    assert "CHF" in currencies and "USD" in currencies
    assert "XAU" not in currencies                       # gold is a COINBULL security
    # CHF 1000 + USD 500*0.8 = 1400 cash tax value.
    assert report.total_cash_tax_value_chf == Decimal("1400.00")
    assert validate_ech0196(statement.to_xml_bytes()).valid


def test_valor_numbers_present_for_swiss_securities():
    import re
    result = classify(parse_input(SAMPLE_CSV.read_bytes()).transactions)
    cfg = StatementConfig(tax_year=2025, client_number="1")
    statement, _ = build_statement(result, cfg)
    xml = statement.to_xml_bytes().decode()
    # Nestlé (CH0038863350) is in the sample CSV → valor 3886335 must be emitted.
    assert 'valorNumber="3886335"' in xml
