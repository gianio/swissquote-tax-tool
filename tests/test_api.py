import json

import pytest
from fastapi.testclient import TestClient

from backend.main import app
from tests.conftest import SAMPLE_CSV

client = TestClient(app)


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_analyze_returns_summary_and_fields():
    files = {"file": ("sample.csv", SAMPLE_CSV.read_bytes(), "text/csv")}
    res = client.post("/api/analyze", files=files)
    assert res.status_code == 200
    data = res.json()
    assert data["ok"] and data["tax_year"] == 2025
    assert "CHF" in data["currencies"]
    assert data["summary"]["zugaenge"]["count"] >= 1


def test_generate_returns_valid_xml():
    files = {"file": ("sample.csv", SAMPLE_CSV.read_bytes(), "text/csv")}
    config = json.dumps({"canton": "ZH", "first_name": "A", "last_name": "B",
                         "client_number": "1", "fx_rates": {"USD": "0.8", "EUR": "0.93"}})
    res = client.post("/api/generate", files=files, data={"config": config})
    assert res.status_code == 200
    data = res.json()
    assert data["ok"]
    assert data["validation"]["valid"] is True
    assert data["xml"].startswith("<?xml")
    assert data["filename"] == "eCH-0196_Swissquote_2025.xml"


def test_pdf_endpoint_returns_barcode_pdf():
    files = {"file": ("sample.csv", SAMPLE_CSV.read_bytes(), "text/csv")}
    config = json.dumps({"canton": "ZH", "client_number": "1",
                         "fx_rates": {"USD": "0.8", "EUR": "0.93"}})
    res = client.post("/api/pdf", files=files, data={"config": config})
    assert res.status_code == 200
    assert res.headers["content-type"] == "application/pdf"
    assert res.content.startswith(b"%PDF")
    assert "attachment" in res.headers.get("content-disposition", "")


def test_generate_rejects_bad_canton():
    files = {"file": ("sample.csv", SAMPLE_CSV.read_bytes(), "text/csv")}
    res = client.post("/api/generate", files=files, data={"config": json.dumps({"canton": "XX"})})
    assert res.status_code == 400


def test_analyze_rejects_garbage():
    files = {"file": ("bad.csv", b"not a swissquote file", "text/csv")}
    res = client.post("/api/analyze", files=files)
    assert res.status_code == 422
