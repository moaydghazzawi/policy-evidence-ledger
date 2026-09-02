from __future__ import annotations

from datetime import date, datetime
from enum import StrEnum
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator, model_validator

MAX_SOURCE_NOTES_LENGTH = 4000


class SourceType(StrEnum):
    GOVERNMENT_RULE = "government_rule"
    OFFICIAL_STATEMENT = "official_statement"
    LEGISLATION = "legislation"
    COURT_RECORD = "court_record"
    DATASET = "dataset"
    RESEARCH_PAPER = "research_paper"
    REPORT = "report"
    NEWS = "news"
    MANUAL_CITATION = "manual_citation"
    OTHER = "other"


class MetadataStatus(StrEnum):
    PENDING = "pending"
    VERIFIED = "verified"


class IngestMode(StrEnum):
    URL = "url"
    UPLOAD = "upload"
    MANUAL = "manual"
    DEMO = "demo"


class ClaimStatus(StrEnum):
    SUPPORTED = "supported"
    CONTESTED = "contested"
    UNCLEAR = "unclear"
    REJECTED = "rejected"


class Confidence(StrEnum):
    LOW = "low"
    MODERATE = "moderate"
    HIGH = "high"


class EvidenceRole(StrEnum):
    SUPPORTING = "supporting"
    COUNTEREVIDENCE = "counterevidence"


class EvidenceKind(StrEnum):
    PASSAGE = "passage"
    DATA_POINT = "data_point"


class ReviewState(StrEnum):
    DRAFT = "draft"
    APPROVED = "approved"


class LocatorType(StrEnum):
    PAGE = "page"
    SECTION = "section"
    PARAGRAPH = "paragraph"
    TABLE = "table"
    ARTICLE = "article"
    TIMESTAMP = "timestamp"
    OTHER = "other"


class RelationType(StrEnum):
    AGREES = "agrees"
    DISAGREES = "disagrees"
    DIFFERENT_DEFINITION = "different_definition"
    DIFFERENT_PERIOD = "different_period"
    MIXED = "mixed"


class DecisionEntityType(StrEnum):
    CLAIM = "claim"
    DEFINITION = "definition"
    CASE = "case"
    CONCLUSION = "conclusion"


def _not_blank(value: str) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError("must not be blank")
    return cleaned


def _no_embedded_credentials(value: HttpUrl | str | None) -> HttpUrl | str | None:
    if value is not None:
        parsed = urlsplit(str(value))
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("URL must not include embedded credentials")
    return value


class StrictInput(BaseModel):
    model_config = ConfigDict(extra="forbid")


class SourceCreate(StrictInput):
    title: str = Field(min_length=1, max_length=500)
    author_institution: str = Field(min_length=1, max_length=300)
    publication_date: date | None = None
    source_type: SourceType
    url: HttpUrl | None = None
    access_date: date = Field(default_factory=date.today)
    metadata_status: MetadataStatus = MetadataStatus.PENDING
    ingest_mode: IngestMode = IngestMode.MANUAL
    language: str = Field(default="en", min_length=2, max_length=20)
    notes: str = Field(default="", max_length=MAX_SOURCE_NOTES_LENGTH)

    _validate_title = field_validator("title")(_not_blank)
    _validate_author = field_validator("author_institution")(_not_blank)
    _validate_language = field_validator("language")(_not_blank)
    _validate_url = field_validator("url")(_no_embedded_credentials)

    @model_validator(mode="after")
    def require_url_for_url_ingest(self) -> SourceCreate:
        if self.ingest_mode == IngestMode.URL and self.url is None:
            raise ValueError("URL ingestion requires a URL")
        return self


class SourceAliasView(BaseModel):
    id: str
    url: HttpUrl | None
    title: str | None
    author_institution: str | None
    publication_date: date | None
    source_type: SourceType | None
    metadata_status: MetadataStatus | None
    access_date: date | None
    language: str | None
    notes: str | None
    created_at: datetime

    _validate_url = field_validator("url")(_no_embedded_credentials)


class SourceVersionView(BaseModel):
    id: str
    previous_source_id: str
    source_id: str
    url: HttpUrl
    created_at: datetime

    _validate_url = field_validator("url")(_no_embedded_credentials)


class SourceView(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: str
    title: str
    author_institution: str
    publication_date: date | None
    source_type: SourceType
    url: HttpUrl | None
    access_date: date
    document_hash: str | None
    metadata_status: MetadataStatus
    ingest_mode: IngestMode
    content_type: str | None
    language: str
    notes: str
    created_at: datetime
    duplicate: bool = False
    aliases: list[SourceAliasView] = Field(default_factory=list)
    previous_version_id: str | None = None

    _validate_url = field_validator("url")(_no_embedded_credentials)


class ClaimCreate(StrictInput):
    claim_text: str = Field(min_length=1, max_length=4000)
    interpretation: str = Field(min_length=1, max_length=6000)
    confidence: Confidence
    known_limitation: str = Field(min_length=1, max_length=4000)
    status: ClaimStatus
    policy_outcome: str = Field(min_length=1, max_length=300)
    case_name: str = Field(default="", max_length=300)
    time_period: str = Field(default="", max_length=200)

    _validate_claim = field_validator("claim_text")(_not_blank)
    _validate_interpretation = field_validator("interpretation")(_not_blank)
    _validate_limitation = field_validator("known_limitation")(_not_blank)
    _validate_outcome = field_validator("policy_outcome")(_not_blank)


class ClaimView(ClaimCreate):
    id: str
    created_at: datetime
    evidence: list[EvidenceView] = Field(default_factory=list)


class EvidenceCreate(StrictInput):
    claim_id: str
    source_id: str
    role: EvidenceRole
    kind: EvidenceKind
    exact_text: str = Field(min_length=1, max_length=12000)
    locator_type: LocatorType | None = None
    locator: str | None = Field(default=None, max_length=500)
    review_state: ReviewState = ReviewState.DRAFT
    reviewer_note: str = Field(default="", max_length=2000)

    @field_validator("exact_text")
    @classmethod
    def exact_text_must_not_be_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("must not be blank")
        return value

    @model_validator(mode="after")
    def approved_requires_locator(self) -> EvidenceCreate:
        if self.review_state == ReviewState.APPROVED and (
            self.locator_type is None or not (self.locator or "").strip()
        ):
            raise ValueError("approved evidence requires a source locator")
        return self


class EvidenceView(EvidenceCreate):
    id: str
    created_at: datetime


class EvidenceApproval(StrictInput):
    locator_type: LocatorType
    locator: str = Field(min_length=1, max_length=500)
    reviewer_note: str | None = Field(default=None, max_length=2000)

    _validate_locator = field_validator("locator")(_not_blank)


class DefinitionCreate(StrictInput):
    term: str = Field(min_length=1, max_length=200)
    definition: str = Field(min_length=1, max_length=5000)
    scope: str = Field(min_length=1, max_length=1000)
    rationale: str = Field(min_length=1, max_length=2000)

    _validate_term = field_validator("term")(_not_blank)
    _validate_definition = field_validator("definition")(_not_blank)
    _validate_scope = field_validator("scope")(_not_blank)
    _validate_rationale = field_validator("rationale")(_not_blank)


class DefinitionVersionView(DefinitionCreate):
    id: str
    definition_id: str
    version: int
    created_at: datetime


class ComparisonCreate(StrictInput):
    claim_a_id: str
    claim_b_id: str
    relation: RelationType
    rationale: str = Field(min_length=1, max_length=3000)

    _validate_rationale = field_validator("rationale")(_not_blank)

    @model_validator(mode="after")
    def claims_must_differ(self) -> ComparisonCreate:
        if self.claim_a_id == self.claim_b_id:
            raise ValueError("a claim cannot be compared with itself")
        return self


class DecisionCreate(StrictInput):
    entity_type: DecisionEntityType
    entity_id: str = Field(min_length=1, max_length=100)
    before_state: str = Field(default="", max_length=4000)
    after_state: str = Field(min_length=1, max_length=4000)
    rationale: str = Field(min_length=1, max_length=4000)

    _validate_entity_id = field_validator("entity_id")(_not_blank)
    _validate_after = field_validator("after_state")(_not_blank)
    _validate_rationale = field_validator("rationale")(_not_blank)


class DashboardView(BaseModel):
    sources: list[SourceView]
    claims: list[ClaimView]
    definitions: list[DefinitionVersionView]
    comparisons: list[dict[str, str | datetime]]
    decisions: list[dict[str, str | datetime]]
    export_ready: bool
    export_issues: list[str]


ClaimView.model_rebuild()
