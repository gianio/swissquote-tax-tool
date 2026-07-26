"""FastAPI application: Swissquote CSV → eCH-0196 e-Steuerauszug.

Two JSON/multipart endpoints power the single-page frontend:

* ``POST /api/analyze``  – upload the CSV, get a dashboard summary plus the
  detected tax year and the currencies that need an FX rate.
* ``POST /api/generate`` – upload the CSV together with the user's answers and
  get back the summary, a build report and the validated eCH-0196 XML.

The frontend static files are served from ``/``.
"""

from __future__ import annotations

import json
from decimal import Decimal, InvalidOperation
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .classifier import classify
from .config import DEFAULT_FX_RATES, VALID_CANTONS, StatementConfig
from .csv_parser import CsvParseError, infer_tax_year, parse_transactions
from .statement_builder import build_statement
from .summary import build_summary
from .validation import validate_ech0196

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
MAX_UPLOAD_BYTES = 10 * 1024 * 1024  # 10 MB is plenty for a yearly export.

app = FastAPI(title="Swissquote → eCH-0196 Steuerauszug", version="1.0.0")


def _read_upload(file: UploadFile) -> bytes:
    data = file.file.read()
    if not data:
        raise HTTPException(status_code=400, detail="The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status_code=413, detail="File too large (max 10 MB).")
    return data


def _currencies_in(result) -> list[str]:
    seen: set[str] = set()
    for inst in result.instruments:
        seen.add(inst.currency)
    for inc in result.cash_interest:
        seen.add(inc.currency)
    for t in result.metals:
        seen.add(t.currency)
    seen.discard("")
    return sorted(seen)


def _default_fx_for(currencies: list[str]) -> dict:
    return {c: str(DEFAULT_FX_RATES.get(c, Decimal("1"))) for c in currencies}


def _config_from_form(config_json: Optional[str], tax_year: int) -> StatementConfig:
    payload = {}
    if config_json:
        try:
            payload = json.loads(config_json)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid config JSON.")

    canton = (payload.get("canton") or "ZH").upper()
    if canton not in VALID_CANTONS:
        raise HTTPException(status_code=400, detail=f"Unknown canton '{canton}'.")

    fx_rates = dict(DEFAULT_FX_RATES)
    for ccy, value in (payload.get("fx_rates") or {}).items():
        try:
            fx_rates[ccy.upper()] = Decimal(str(value))
        except (InvalidOperation, ValueError):
            raise HTTPException(status_code=400, detail=f"Invalid FX rate for {ccy}.")

    return StatementConfig(
        tax_year=int(payload.get("tax_year") or tax_year),
        canton=canton,
        first_name=(payload.get("first_name") or "").strip(),
        last_name=(payload.get("last_name") or "").strip(),
        client_number=(payload.get("client_number") or "").strip(),
        depot_number=(payload.get("depot_number") or "1").strip() or "1",
        institution_name=(payload.get("institution_name") or "Swissquote Bank AG").strip(),
        country=(payload.get("country") or "CH").upper()[:2],
        include_options=bool(payload.get("include_options", True)),
        include_crypto=bool(payload.get("include_crypto", True)),
        include_metals=bool(payload.get("include_metals", True)),
        fx_rates=fx_rates,
    )


@app.post("/api/analyze")
async def analyze(file: UploadFile = File(...)) -> JSONResponse:
    """Parse the CSV and return a preview summary + detected fields."""
    data = _read_upload(file)
    try:
        transactions = parse_transactions(data)
    except CsvParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    tax_year = infer_tax_year(transactions)
    result = classify(transactions)
    currencies = _currencies_in(result)
    preview_config = StatementConfig(tax_year=tax_year)
    summary = build_summary(result, preview_config)

    return JSONResponse({
        "ok": True,
        "tax_year": tax_year,
        "transaction_count": len(transactions),
        "currencies": currencies,
        "default_fx_rates": _default_fx_for(currencies),
        "cantons": VALID_CANTONS,
        "summary": summary,
        "warnings": result.warnings,
    })


@app.post("/api/generate")
async def generate(
    file: UploadFile = File(...),
    config: Optional[str] = Form(default=None),
) -> JSONResponse:
    """Build the eCH-0196 statement from the CSV + the user's answers."""
    data = _read_upload(file)
    try:
        transactions = parse_transactions(data)
    except CsvParseError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    tax_year = infer_tax_year(transactions)
    cfg = _config_from_form(config, tax_year)
    result = classify(transactions, default_country=cfg.country)
    summary = build_summary(result, cfg)
    statement, report = build_statement(result, cfg)

    xml_bytes = statement.to_xml_bytes()
    validation = validate_ech0196(xml_bytes)

    return JSONResponse({
        "ok": True,
        "filename": f"eCH-0196_Swissquote_{cfg.tax_year}.xml",
        "xml": xml_bytes.decode("utf-8"),
        "validation": {
            "valid": validation.valid,
            "errors": validation.errors[:20],
            "schema_available": validation.schema_available,
        },
        "report": {
            "included": [
                {
                    "name": p.name,
                    "isin": p.isin,
                    "category": p.category,
                    "currency": p.currency,
                    "closing_quantity": float(p.closing_quantity),
                    "opening_inferred": p.opening_inferred,
                    "tax_value_chf": float(p.tax_value_chf),
                    "gross_income_chf": float(p.gross_income_chf),
                    "value_is_estimate": p.value_is_estimate,
                }
                for p in report.included
            ],
            "excluded": report.excluded,
            "warnings": report.warnings,
            "totals": {
                "tax_value_chf": float(report.total_tax_value_chf),
                "gross_revenue_a_chf": float(report.total_gross_revenue_a_chf),
                "gross_revenue_b_chf": float(report.total_gross_revenue_b_chf),
                "withholding_tax_claim_chf": float(report.total_withholding_tax_claim_chf),
                "foreign_withholding_chf": float(report.total_foreign_withholding_chf),
                "bank_interest_chf": float(report.total_bank_interest_chf),
            },
        },
        "summary": summary,
    })


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


# Serve the single-page frontend from the project's ``frontend`` directory.
# Mounted last so the /api/* routes above take priority; html=True serves
# index.html at "/".
if FRONTEND_DIR.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")
