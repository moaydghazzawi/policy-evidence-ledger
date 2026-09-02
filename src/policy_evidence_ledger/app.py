from __future__ import annotations

import os
from contextlib import asynccontextmanager
from datetime import date
from pathlib import Path
from typing import Annotated
from urllib.parse import urlsplit

import httpx
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError
from starlette.middleware.trustedhost import TrustedHostMiddleware

from .exports import ExportBlocked, generate_export_bundle
from .ingestion import MAX_SOURCE_BYTES, fetch_public_source
from .schemas import (
    MAX_SOURCE_NOTES_LENGTH,
    ClaimCreate,
    ComparisonCreate,
    DecisionCreate,
    DefinitionCreate,
    EvidenceApproval,
    EvidenceCreate,
    IngestMode,
    MetadataStatus,
    SourceCreate,
    SourceType,
)
from .seed import seed_demo
from .storage import LedgerStore

ANTI_FRAMING_HEADERS = {
    "Content-Security-Policy": "frame-ancestors 'none'",
    "X-Frame-Options": "DENY",
}


def project_root() -> Path:
    return Path(__file__).resolve().parents[2]


def instance_dir() -> Path:
    configured = os.environ.get("PEL_INSTANCE_DIR")
    return Path(configured).expanduser().resolve() if configured else project_root() / "instance"


@asynccontextmanager
async def lifespan(app: FastAPI):
    data_dir = instance_dir()
    store = LedgerStore(data_dir / "ledger.sqlite3", data_dir / "blobs")
    app.state.store = store
    if os.environ.get("PEL_AUTO_SEED", "true").lower() not in {"0", "false", "no"}:
        seed_demo(store)
    yield


app = FastAPI(
    title="Policy Evidence Ledger API",
    version="0.1.0",
    description=(
        "Local-only research API. Evidence exports fail closed unless each claim has "
        "approved evidence with a real source locator."
    ),
    lifespan=lifespan,
)

app.add_middleware(
    TrustedHostMiddleware,
    allowed_hosts=["127.0.0.1", "localhost", "testserver"],
)
app.add_middleware(
    CORSMiddleware,
    allow_origin_regex=r"^http://(?:127\.0\.0\.1|localhost)(?::[0-9]{1,5})?$",
    allow_methods=["GET", "POST", "PATCH"],
    allow_headers=["Content-Type"],
)


def _is_loopback_origin(origin: str) -> bool:
    try:
        parsed = urlsplit(origin)
        port = parsed.port
    except ValueError:
        return False
    return (
        parsed.scheme == "http"
        and parsed.hostname in {"127.0.0.1", "localhost"}
        and parsed.username is None
        and parsed.password is None
        and not parsed.path
        and not parsed.query
        and not parsed.fragment
        and (port is None or 1 <= port <= 65535)
    )


@app.middleware("http")
async def reject_cross_origin_writes(request: Request, call_next):
    if request.url.path.startswith("/api/") and request.method not in {
        "GET",
        "HEAD",
        "OPTIONS",
    }:
        origin = request.headers.get("origin")
        cross_site_without_origin = (
            origin is None and request.headers.get("sec-fetch-site", "").lower() == "cross-site"
        )
        if (origin is not None and not _is_loopback_origin(origin)) or cross_site_without_origin:
            response = JSONResponse(
                status_code=403,
                content={"detail": "cross-origin writes are not allowed"},
            )
            response.headers.update(ANTI_FRAMING_HEADERS)
            return response
    response = await call_next(request)
    response.headers.update(ANTI_FRAMING_HEADERS)
    return response


def get_store(request: Request) -> LedgerStore:
    return request.app.state.store


@app.exception_handler(KeyError)
async def key_error_handler(_request: Request, exc: KeyError) -> JSONResponse:
    return JSONResponse(status_code=404, content={"detail": str(exc).strip("'")})


@app.exception_handler(ValueError)
async def value_error_handler(_request: Request, exc: ValueError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": str(exc)})


@app.exception_handler(httpx.HTTPError)
async def upstream_error_handler(_request: Request, _exc: httpx.HTTPError) -> JSONResponse:
    return JSONResponse(
        status_code=502,
        content={"detail": "the public source could not be fetched from the remote server"},
    )


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok", "storage": "local", "version": "0.1.0"}


@app.get("/api/dashboard")
def dashboard(request: Request):
    return get_store(request).dashboard()


@app.get("/api/sources")
def list_sources(request: Request):
    return get_store(request).list_sources()


@app.post("/api/sources", status_code=201)
async def add_source(source: SourceCreate, request: Request):
    store = get_store(request)
    if source.ingest_mode not in {IngestMode.URL, IngestMode.MANUAL}:
        raise ValueError("use the upload endpoint for files; demo ingestion is internal only")
    source = source.model_copy(update={"metadata_status": MetadataStatus.PENDING})
    if source.ingest_mode != IngestMode.URL:
        duplicates = store.citation_duplicates(source)
        view = store.add_source(source)
        return {
            "source": view,
            "citation_duplicate_warning": [item.id for item in duplicates],
        }

    fetched = await fetch_public_source(str(source.url))
    updated = source
    if fetched.final_url != str(source.url):
        redirect_note = f"Resolved download URL: {fetched.final_url}"
        existing_notes = source.notes.rstrip()
        separator = "\n" if existing_notes else ""
        available = MAX_SOURCE_NOTES_LENGTH - len(separator) - len(redirect_note)
        bounded_notes = existing_notes[: max(available, 0)].rstrip()
        combined_notes = f"{bounded_notes}{separator if bounded_notes else ''}{redirect_note}"
        updated = SourceCreate.model_validate({**source.model_dump(), "notes": combined_notes})
    return {
        "source": store.add_source(updated, fetched.content, fetched.content_type),
        "citation_duplicate_warning": [],
    }


@app.post("/api/sources/upload", status_code=201)
async def upload_source(
    request: Request,
    file: Annotated[UploadFile, File(description="PDF, HTML, XHTML, or plain text")],
    title: Annotated[str, Form()],
    author_institution: Annotated[str, Form()],
    source_type: Annotated[SourceType, Form()],
    publication_date: Annotated[date | None, Form()] = None,
    url: Annotated[str | None, Form()] = None,
    language: Annotated[str, Form()] = "en",
):
    content_type = (file.content_type or "").split(";", 1)[0].lower()
    if content_type not in {"application/pdf", "text/html", "application/xhtml+xml", "text/plain"}:
        raise HTTPException(status_code=415, detail="upload must be PDF, HTML, XHTML, or text")
    content = await file.read(MAX_SOURCE_BYTES + 1)
    if len(content) > MAX_SOURCE_BYTES:
        raise HTTPException(status_code=413, detail="upload exceeds the 25 MB limit")
    if not content:
        raise HTTPException(status_code=422, detail="upload is empty")
    try:
        source = SourceCreate(
            title=title,
            author_institution=author_institution,
            publication_date=publication_date,
            source_type=source_type,
            url=url or None,
            metadata_status=MetadataStatus.PENDING,
            ingest_mode=IngestMode.UPLOAD,
            language=language,
            notes=f"Local upload: {Path(file.filename or 'source').name}",
        )
    except ValidationError as exc:
        raise HTTPException(
            status_code=422,
            detail=exc.errors(include_context=False, include_url=False),
        ) from exc
    view = get_store(request).add_source(source, content, content_type)
    return {"source": view, "citation_duplicate_warning": []}


@app.patch("/api/sources/{source_id}/verify")
def verify_source(source_id: str, request: Request):
    return get_store(request).verify_source(source_id)


@app.get("/api/claims")
def list_claims(request: Request):
    return get_store(request).list_claims()


@app.post("/api/claims", status_code=201)
def add_claim(claim: ClaimCreate, request: Request):
    return get_store(request).add_claim(claim)


@app.post("/api/evidence", status_code=201)
def add_evidence(evidence: EvidenceCreate, request: Request):
    return get_store(request).add_evidence(evidence)


@app.patch("/api/evidence/{evidence_id}/approve")
def approve_evidence(evidence_id: str, request: Request, approval: EvidenceApproval | None = None):
    return get_store(request).approve_evidence(evidence_id, approval)


@app.post("/api/definitions", status_code=201)
def add_definition(definition: DefinitionCreate, request: Request):
    return get_store(request).add_definition(definition)


@app.post("/api/comparisons", status_code=201)
def add_comparison(comparison: ComparisonCreate, request: Request):
    return get_store(request).add_comparison(comparison)


@app.post("/api/decisions", status_code=201)
def add_decision(decision: DecisionCreate, request: Request):
    return get_store(request).add_decision(decision)


@app.get("/api/export/readiness")
def export_readiness(request: Request):
    issues = get_store(request).export_issues()
    return {"ready": not issues, "issues": issues}


@app.post("/api/export")
def export_research(request: Request):
    try:
        archive, filename = generate_export_bundle(get_store(request))
    except ExportBlocked as exc:
        return JSONResponse(
            status_code=422, content={"detail": "Export blocked", "issues": exc.issues}
        )
    return Response(
        archive,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


frontend_dir = project_root() / "dist" / "client"
if frontend_dir.exists():
    assets_dir = frontend_dir / "assets"
    if assets_dir.exists():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def frontend(path: str):
        if path == "api" or path.startswith("api/"):
            raise HTTPException(status_code=404, detail="API route not found")
        candidate = (frontend_dir / path).resolve()
        if candidate.is_file() and frontend_dir.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(frontend_dir / "index.html")
