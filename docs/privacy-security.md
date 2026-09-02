# Privacy and security

Policy Evidence Ledger is local-first: its Python service stores research data in a local SQLite database and source snapshots in a local blob directory. It has no telemetry, user account, analytics service, model provider, or cloud database in the MVP.

## Local data boundary

By default, runtime data lives under `instance/`:

```text
instance/
├── ledger.sqlite3
└── blobs/
    └── <sha256 digest>
```

The directory is excluded from Git. You can move it with `--instance-dir`. The CLI accepts loopback addresses only, and the API rejects untrusted Host headers, so the MVP is not directly reachable from another computer.

State-changing API routes also reject browser requests carrying a non-loopback `Origin` header, or a cross-site fetch marker without an origin. Backend responses and the development and hosted frontends set `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` to prevent clickjacking through a framed local workspace. These controls protect the unauthenticated loopback service from ordinary cross-origin and framing attacks; they are not a replacement for authentication if the service is ever exposed beyond a trusted machine.

The static public preview contains only the six-source public demonstration. It cannot read or modify a local ledger unless it is served with the local Python backend.

## Repository safeguards

`.gitignore` excludes runtime databases, content-addressed blobs even under a custom in-repository instance path, exports, uploads, environment files, common raw research-document formats, private keys, and generated build/test state. `scripts/audit_tracked_files.py` examines every tracked or unignored candidate file, separately reads worktree and staged bytes, rejects those blocked types and blob paths, caps unexpected file size, and scans file bytes for common GitHub, OpenAI, AWS, and private-key patterns.

Run this before staging or pushing:

```bash
npm run audit:tracked
```

This is defense in depth, not a content-classification guarantee. Screenshots and other intentionally tracked media require visual and metadata review because an automated token scan cannot determine whether an image discloses private research. Review `git status`, `git diff --cached --stat`, and `git diff --cached` before every push.

## Source integrity

Downloaded and uploaded source bytes are hashed with SHA-256 before content-addressed storage. Exports recompute the hash and stop if a snapshot has changed. Identical bytes are deduplicated; changed bytes at the same URL create a new record. Manual citations and the seeded demo have no captured bytes, so the system labels their hash unavailable rather than implying integrity it cannot prove.

## Network ingestion

The URL importer:

- accepts only `http` and `https`;
- resolves the hostname and rejects loopback, link-local, private, reserved, multicast, unspecified, IPv4-mapped, 6to4, Teredo, and NAT64 addresses;
- validates every redirect before following it;
- accepts only PDF, HTML, XHTML, and plain text;
- refuses responses larger than 25 MB;
- uses finite connection/read timeouts.

Manual citations and upload metadata reject URLs containing embedded usernames or passwords so credentials cannot be copied into an export.

These checks reduce server-side request forgery risk but are not a substitute for a hardened network sandbox.

The SQLite ledger is not cryptographically signed. Export performs defensive consistency checks, but an operator with direct database write access can alter provenance fields. Treat filesystem access as trusted and verify publication-critical citations against the original records.

## Human and machine boundary

The MVP does not call an AI model. The database reserves machine suggestions in a separate table with an `unverified` state. They cannot become evidence without an explicit human action and are excluded from exports. A generated paraphrase must never be entered as an exact source passage.

## Threat-model limits

The app does not provide authentication, authorization, encryption at rest, audit-log signing, malware scanning, sandboxed document rendering, or multi-user isolation. It is intended for one researcher on a trusted machine. For sensitive work:

- use full-disk encryption and an encrypted backup;
- keep the service on loopback;
- inspect uploaded files with trusted security tooling;
- use a separate scoped instance when only part of a ledger should be shared, then review the entire export bundle;
- verify citation text against the original source before publication;
- do not publish the `instance/` directory or expose the API directly to the internet.
