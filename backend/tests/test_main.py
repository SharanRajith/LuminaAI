import io
import json
import pytest
from unittest.mock import MagicMock, patch
from pydantic import ValidationError

# Patch supabase before importing main so the module loads without real credentials
import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

with patch("supabase.create_client", return_value=MagicMock()):
    from main import (
        extract_json,
        PresentationRequest,
        ReportRequest,
        app,
    )

from fastapi.testclient import TestClient
client = TestClient(app)


# ─────────────────────── extract_json ────────────────────────

class TestExtractJson:
    def test_simple_object(self):
        text = '{"title": "Hello", "count": 3}'
        result = extract_json(text)
        assert result == {"title": "Hello", "count": 3}

    def test_strips_html_from_string_values(self):
        text = '{"title": "<b>Bold</b> text"}'
        result = extract_json(text)
        assert result["title"] == "Bold text"

    def test_nested_object(self):
        text = '{"outer": {"inner": "value"}}'
        result = extract_json(text)
        assert result["outer"]["inner"] == "value"

    def test_json_embedded_in_prose(self):
        text = 'Here is the data: {"slides": [1, 2, 3]} and some trailing text.'
        result = extract_json(text)
        assert result["slides"] == [1, 2, 3]

    def test_raises_when_no_json(self):
        with pytest.raises(ValueError, match="No JSON object"):
            extract_json("There is no JSON here at all.")

    def test_raises_on_malformed_json(self):
        with pytest.raises(ValueError, match="Malformed JSON"):
            extract_json('{"key": "value", bad_syntax}')

    def test_html_stripped_in_nested_lists(self):
        text = '{"items": ["<em>one</em>", "<b>two</b>"]}'
        result = extract_json(text)
        assert result["items"] == ["one", "two"]

    def test_non_string_values_unchanged(self):
        text = '{"count": 42, "flag": true, "ratio": 3.14}'
        result = extract_json(text)
        assert result == {"count": 42, "flag": True, "ratio": 3.14}


# ──────────────────── PresentationRequest validators ──────────

class TestPresentationRequest:
    def _base(self, **kwargs):
        defaults = dict(
            prompt="The future of renewable energy",
            theme="dark",
            slide_count=10,
            audience="general",
            tone="professional",
        )
        defaults.update(kwargs)
        return defaults

    def test_valid_request(self):
        req = PresentationRequest(**self._base())
        assert req.prompt == "The future of renewable energy"

    def test_prompt_too_short(self):
        with pytest.raises(ValidationError):
            PresentationRequest(**self._base(prompt="Hi"))

    def test_prompt_too_long(self):
        with pytest.raises(ValidationError):
            PresentationRequest(**self._base(prompt="x" * 5001))

    def test_invalid_theme(self):
        with pytest.raises(ValidationError, match="theme must be one of"):
            PresentationRequest(**self._base(theme="neon"))

    def test_all_valid_themes(self):
        for theme in ("dark", "ocean", "sunset", "emerald", "corporate"):
            req = PresentationRequest(**self._base(theme=theme))
            assert req.theme == theme

    def test_invalid_tone(self):
        with pytest.raises(ValidationError, match="tone must be one of"):
            PresentationRequest(**self._base(tone="angry"))

    def test_invalid_audience(self):
        with pytest.raises(ValidationError, match="audience must be one of"):
            PresentationRequest(**self._base(audience="aliens"))

    def test_slide_count_too_low(self):
        with pytest.raises(ValidationError):
            PresentationRequest(**self._base(slide_count=2))

    def test_slide_count_too_high(self):
        with pytest.raises(ValidationError):
            PresentationRequest(**self._base(slide_count=51))

    def test_slide_count_boundary_values(self):
        req_min = PresentationRequest(**self._base(slide_count=3))
        req_max = PresentationRequest(**self._base(slide_count=50))
        assert req_min.slide_count == 3
        assert req_max.slide_count == 50


# ────────────────────── ReportRequest validators ──────────────

class TestReportRequest:
    def _base(self, **kwargs):
        defaults = dict(
            prompt="Market trends in electric vehicles",
            report_type="business",
            tone="professional",
            length="medium",
        )
        defaults.update(kwargs)
        return defaults

    def test_valid_request(self):
        req = ReportRequest(**self._base())
        assert req.report_type == "business"

    def test_invalid_report_type(self):
        with pytest.raises(ValidationError, match="report_type must be one of"):
            ReportRequest(**self._base(report_type="gossip"))

    def test_invalid_length(self):
        with pytest.raises(ValidationError, match="length must be one of"):
            ReportRequest(**self._base(length="massive"))

    def test_all_valid_lengths(self):
        for length in ("short", "medium", "long"):
            req = ReportRequest(**self._base(length=length))
            assert req.length == length

    def test_prompt_min_length(self):
        with pytest.raises(ValidationError):
            ReportRequest(**self._base(prompt="EV"))


# ─────────────────────── Health endpoint ─────────────────────

class TestHealthEndpoint:
    def test_health_returns_ok(self):
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}
