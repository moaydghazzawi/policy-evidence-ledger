from __future__ import annotations

import asyncio
import ipaddress

import httpx
import pytest

from policy_evidence_ledger import ingestion


@pytest.mark.parametrize(
    "url, message",
    [
        ("file:///etc/passwd", "only http and https"),
        ("http://127.0.0.1/source", "private or reserved"),
        ("http://224.0.0.1/source", "private or reserved"),
        ("http://239.255.255.250/source", "private or reserved"),
        ("http://[ff02::1]/source", "private or reserved"),
        ("http://[::ffff:127.0.0.1]/source", "private or reserved"),
        ("http://[2002:7f00:1::]/source", "private or reserved"),
        ("http://[2001:0000:4136:e378:8000:63bf:3fff:fdd2]/source", "private or reserved"),
        ("http://[64:ff9b::7f00:1]/source", "private or reserved"),
        ("http://[64:ff9b::a9fe:a9fe]/source", "private or reserved"),
        ("http://[64:ff9b::c0a8:1]/source", "private or reserved"),
        ("http://[64:ff9b:1::c0a8:1]/source", "private or reserved"),
        ("https://user:secret@example.com/source", "embedded credentials"),
    ],
)
def test_source_url_validation_rejects_unsafe_inputs(url: str, message: str) -> None:
    with pytest.raises(ingestion.UnsafeSourceURL, match=message):
        ingestion.validate_public_http_url(url)


def test_address_policy_allows_an_ordinary_public_address() -> None:
    assert ingestion.is_public_source_address(ipaddress.ip_address("2606:4700:4700::1111"))


def test_redirect_target_is_validated_before_request(monkeypatch) -> None:
    validated: list[str] = []
    requested: list[str] = []

    def validate(url: str) -> None:
        validated.append(url)
        if "127.0.0.1" in url:
            raise ingestion.UnsafeSourceURL("private redirect blocked")

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        return httpx.Response(302, headers={"location": "http://127.0.0.1/private"})

    monkeypatch.setattr(ingestion, "validate_public_http_url", validate)
    with pytest.raises(ingestion.UnsafeSourceURL, match="private redirect blocked"):
        asyncio.run(
            ingestion.fetch_public_source(
                "https://public.example/source",
                _transport=httpx.MockTransport(handler),
            )
        )

    assert requested == ["https://public.example/source"]
    assert validated[-1] == "http://127.0.0.1/private"


def test_public_relative_redirect_can_complete(monkeypatch) -> None:
    requested: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requested.append(str(request.url))
        if request.url.path == "/source":
            return httpx.Response(302, headers={"location": "/final"})
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"record")

    monkeypatch.setattr(ingestion, "validate_public_http_url", lambda _url: None)
    result = asyncio.run(
        ingestion.fetch_public_source(
            "https://public.example/source",
            _transport=httpx.MockTransport(handler),
        )
    )

    assert requested == ["https://public.example/source", "https://public.example/final"]
    assert result.final_url == "https://public.example/final"
    assert result.content == b"record"


def test_fetch_rejects_unsupported_type_and_oversized_length(monkeypatch) -> None:
    monkeypatch.setattr(ingestion, "validate_public_http_url", lambda _url: None)

    def unsupported(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "application/zip"}, content=b"x")

    with pytest.raises(ValueError, match="PDF, HTML"):
        asyncio.run(
            ingestion.fetch_public_source(
                "https://public.example/source", _transport=httpx.MockTransport(unsupported)
            )
        )

    def oversized(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={
                "content-type": "text/plain",
                "content-length": str(ingestion.MAX_SOURCE_BYTES + 1),
            },
            content=b"x",
        )

    with pytest.raises(ValueError, match="25 MB"):
        asyncio.run(
            ingestion.fetch_public_source(
                "https://public.example/source", _transport=httpx.MockTransport(oversized)
            )
        )


def test_fetch_rejects_empty_document(monkeypatch) -> None:
    monkeypatch.setattr(ingestion, "validate_public_http_url", lambda _url: None)

    def empty(_request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-type": "text/plain"}, content=b"")

    with pytest.raises(ValueError, match="empty"):
        asyncio.run(
            ingestion.fetch_public_source(
                "https://public.example/source", _transport=httpx.MockTransport(empty)
            )
        )
