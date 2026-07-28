"""Aggregate classified transactions into a dashboard summary.

Produces a plain, JSON-serialisable dict with the figures the web UI shows:
Zugänge (purchases), Abgänge (disposals) and Dividenden, plus per-currency and
per-category breakdowns and the reconstructed year-end positions.  All CHF
figures use the user-supplied FX rates and are clearly estimates.
"""

from __future__ import annotations

from collections import defaultdict
from decimal import Decimal, ROUND_HALF_UP
from typing import Dict, List

from .classifier import ClassificationResult
from .config import StatementConfig

_TWO = Decimal("0.01")


def _f(value: Decimal) -> float:
    """Round a Decimal to 2 dp and return a float for JSON."""
    return float(value.quantize(_TWO, rounding=ROUND_HALF_UP))


def _month_key(d) -> str:
    return f"{d.year:04d}-{d.month:02d}"


def build_summary(result: ClassificationResult, config: StatementConfig, cash_balances=None) -> dict:
    rate = config.rate

    # --- Zugänge / Abgänge (purchases and disposals of securities) ---------
    buy_count = sell_count = 0
    buy_chf = sell_chf = Decimal(0)
    buy_by_ccy: Dict[str, Decimal] = defaultdict(Decimal)
    sell_by_ccy: Dict[str, Decimal] = defaultdict(Decimal)

    for inst in result.instruments:
        for m in inst.movements:
            value = (m.gross_amount or Decimal(0))
            chf = value * rate(m.currency)
            if m.is_addition:
                buy_count += 1
                buy_chf += chf
                buy_by_ccy[m.currency] += value
            else:
                sell_count += 1
                sell_chf += chf
                sell_by_ccy[m.currency] += value

    # --- Dividenden / income ----------------------------------------------
    div_count = 0
    div_gross_chf = div_net_chf = Decimal(0)
    swiss_wht_chf = foreign_wht_chf = Decimal(0)
    div_by_ccy: Dict[str, Decimal] = defaultdict(Decimal)
    div_by_month: Dict[str, Decimal] = defaultdict(Decimal)
    div_items: List[dict] = []

    for inst in result.instruments:
        is_swiss = inst.country == "CH"
        for inc in inst.income:
            div_count += 1
            r = rate(inc.currency)
            gross_chf = inc.gross * r
            div_gross_chf += gross_chf
            div_net_chf += inc.net * r
            div_by_ccy[inc.currency] += inc.gross
            div_by_month[_month_key(inc.date)] += gross_chf
            if is_swiss:
                swiss_wht_chf += inc.tax * r
            else:
                foreign_wht_chf += inc.tax * r
            div_items.append({
                "date": inc.date.isoformat(),
                "name": inst.name,
                "isin": inst.isin,
                "type": inc.type,
                "currency": inc.currency,
                "gross": _f(inc.gross),
                "tax": _f(inc.tax),
                "net": _f(inc.net),
                "gross_chf": _f(gross_chf),
                "swiss": is_swiss,
            })

    div_items.sort(key=lambda d: d["gross_chf"], reverse=True)

    # --- Bank interest -----------------------------------------------------
    interest_chf = Decimal(0)
    for inc in result.cash_interest:
        interest_chf += inc.gross * rate(inc.currency)

    # --- Fees --------------------------------------------------------------
    fees_chf = Decimal(0)
    for f in result.fees:
        fees_chf += (f.costs or f.gross_amount or Decimal(0)) * rate(f.currency)

    # --- Positions (reconstructed holdings) --------------------------------
    positions: List[dict] = []
    category_value: Dict[str, Decimal] = defaultdict(Decimal)
    for inst in result.instruments:
        last_price = None
        for m in sorted(inst.movements, key=lambda x: (x.date, -x.source_row), reverse=True):
            if m.unit_price and m.unit_price > 0:
                last_price = m.unit_price
                break
        est_value = Decimal(0)
        if inst.closing_quantity != 0 and last_price is not None:
            est_value = inst.closing_quantity * last_price * rate(inst.currency)
        income_chf = sum((inc.gross * rate(inc.currency) for inc in inst.income), Decimal(0))
        category_value[inst.category] += est_value
        positions.append({
            "name": inst.name,
            "isin": inst.isin,
            "symbol": inst.symbol,
            "category": inst.category,
            "currency": inst.currency,
            "country": inst.country,
            "closing_quantity": float(inst.closing_quantity),
            "opening_inferred": inst.opening_inferred,
            "tax_value_chf": _f(est_value),
            "income_chf": _f(income_chf),
            "trades": len(inst.movements),
        })
    positions.sort(key=lambda p: p["tax_value_chf"], reverse=True)

    # --- Excluded cash movements (for transparency) ------------------------
    card_spend_chf = Decimal(0)
    deposits_chf = Decimal(0)
    for t in result.ignored_cash:
        if t.type == "Kartentransaktion":
            card_spend_chf += abs(t.net_amount or Decimal(0)) * rate(t.currency)
        elif t.type == "Zahlung":
            deposits_chf += (t.net_amount or Decimal(0)) * rate(t.currency)

    def ccy_list(d: Dict[str, Decimal]) -> List[dict]:
        return [
            {"currency": c, "amount": _f(v), "amount_chf": _f(v * rate(c))}
            for c, v in sorted(d.items(), key=lambda kv: kv[1] * rate(kv[0]), reverse=True)
        ]

    # --- Year-end cash balances per currency (from the Kontoauszug PDF) -----
    cash_list: List[dict] = []
    cash_total_chf = Decimal(0)
    for bal in (cash_balances or []):
        if bal.currency == "XAU":
            continue  # gold is shown as a precious-metal position, not cash
        chf = bal.amount * rate(bal.currency)
        cash_total_chf += chf
        cash_list.append({
            "currency": bal.currency,
            "amount": float(bal.amount),
            "amount_chf": _f(chf),
        })

    return {
        "tax_year": config.tax_year,
        "totals": {
            "positions": len([p for p in positions if p["closing_quantity"] != 0]),
            "instruments_traded": len(result.instruments),
            "estimated_portfolio_chf": _f(sum(category_value.values(), Decimal(0))),
            "cash_total_chf": _f(cash_total_chf),
        },
        "cash_balances": cash_list,
        "zugaenge": {
            "count": buy_count,
            "total_chf": _f(buy_chf),
            "by_currency": ccy_list(buy_by_ccy),
        },
        "abgaenge": {
            "count": sell_count,
            "total_chf": _f(sell_chf),
            "by_currency": ccy_list(sell_by_ccy),
        },
        "dividenden": {
            "count": div_count,
            "gross_chf": _f(div_gross_chf),
            "net_chf": _f(div_net_chf),
            "swiss_withholding_chf": _f(swiss_wht_chf),
            "foreign_withholding_chf": _f(foreign_wht_chf),
            "by_currency": ccy_list(div_by_ccy),
            "by_month": [
                {"month": m, "gross_chf": _f(div_by_month[m])}
                for m in sorted(div_by_month)
            ],
            "top": div_items[:15],
        },
        "bank_interest_chf": _f(interest_chf),
        "fees_chf": _f(fees_chf),
        "category_breakdown": [
            {"category": c, "value_chf": _f(v)}
            for c, v in sorted(category_value.items(), key=lambda kv: kv[1], reverse=True)
        ],
        "positions": positions,
        "excluded": {
            "card_spending_chf": _f(card_spend_chf),
            "deposits_chf": _f(deposits_chf),
            "ignored_cash_rows": len(result.ignored_cash),
            "metal_legs": len(result.metals),
        },
        "warnings": result.warnings,
    }
