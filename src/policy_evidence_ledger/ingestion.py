from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

import httpx

MAX_SOURCE_BYTES = 25 * 1024 * 1024
MAX_REDIRECTS = 5
REDIRECT_STATUS_CODES = {301, 302, 303, 307, 308}
ALLOWED_CONTENT_TYPES = {
    "application/pdf",
    "text/html",
    "text/plain",
    "application/xhtml+xml",
}
IPV6_TRANSLATION_NETWORKS = (
    ipaddress.IPv6Network("64:ff9b::/96"),
    ipaddress.IPv6Network("64:ff9b:1::/48"),
)


class UnsafeSourceURL(ValueError):
    pass


@dataclass(frozen=True)
class FetchedSource:
    content: bytes
    content_type: str
    final_url: str


def is_public_source_address(
    address: ipaddress.IPv4Address | ipaddress.IPv6Address,
) -> bool:
    if (
        address.is_private
        or address.is_loopback
        or address.is_link_local
        or address.is_reserved
        or address.is_multicast
        or address.is_unspecified
        or not address.is_global
    ):
        return False
    if not isinstance(address, ipaddress.IPv6Address):
        return True
    return not (
        address.ipv4_mapped is not None
        or address.sixtofour is not None
        or address.teredo is not None
        or any(address in network for network in IPV6_TRANSLATION_NETWORKS)
    )


def validate_public_http_url(url: str) -> None:
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise UnsafeSourceURL("only http and https source URLs are allowed")
    if not parsed.hostname:
        raise UnsafeSourceURL("source URL must include a hostname")
    if parsed.username is not None or parsed.password is not None:
        raise UnsafeSourceURL("source URL must not include embedded credentials")

    try:
        port = parsed.port or (443 if parsed.scheme == "https" else 80)
        addresses = socket.getaddrinfo(parsed.hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UnsafeSourceURL("source hostname could not be resolved") from exc

    for address in addresses:
        ip = ipaddress.ip_address(address[4][0])
        if not is_public_source_address(ip):
            raise UnsafeSourceURL("source URL resolves to a private or reserved network")


async def fetch_public_source(
    url: str, *, _transport: httpx.AsyncBaseTransport | None = None
) -> FetchedSource:
    headers = {"User-Agent": "PolicyEvidenceLedger/0.1 (+local research tool)"}
    timeout = httpx.Timeout(30.0, connect=10.0)
    current_url = url
    async with httpx.AsyncClient(
        follow_redirects=False,
        timeout=timeout,
        headers=headers,
        transport=_transport,
    ) as client:
        for redirect_count in range(MAX_REDIRECTS + 1):
            # Validate immediately before every network request. In particular, a
            # redirect target is rejected before the client is allowed to contact it.
            validate_public_http_url(current_url)
            async with client.stream("GET", current_url) as response:
                if response.status_code in REDIRECT_STATUS_CODES:
                    location = response.headers.get("location")
                    if not location:
                        raise ValueError("source redirect did not include a location")
                    if redirect_count == MAX_REDIRECTS:
                        raise ValueError("source exceeded the redirect limit")
                    next_url = str(response.url.join(location))
                    validate_public_http_url(next_url)
                    current_url = next_url
                    continue

                response.raise_for_status()
                final_url = str(response.url)
                content_type = response.headers.get("content-type", "").split(";", 1)[0].lower()
                if content_type not in ALLOWED_CONTENT_TYPES:
                    raise ValueError(
                        "source must be a PDF, HTML page, XHTML page, or plain-text document"
                    )
                content_length = response.headers.get("content-length")
                if content_length and int(content_length) > MAX_SOURCE_BYTES:
                    raise ValueError("source exceeds the 25 MB local ingestion limit")
                chunks: list[bytes] = []
                total = 0
                async for chunk in response.aiter_bytes():
                    total += len(chunk)
                    if total > MAX_SOURCE_BYTES:
                        raise ValueError("source exceeds the 25 MB local ingestion limit")
                    chunks.append(chunk)
                if total == 0:
                    raise ValueError("source response was empty")
                return FetchedSource(
                    content=b"".join(chunks),
                    content_type=content_type,
                    final_url=final_url,
                )

    raise ValueError("source could not be fetched")
