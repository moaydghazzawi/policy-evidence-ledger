# Privacy and security

Policy Evidence Ledger offers two separate storage modes. The standalone Python service keeps research in local SQLite and source files on your device. The online edition uses ChatGPT sign-in, D1 structured storage, and private R2 source snapshots. The app has no analytics tracker or AI model call. Hosting infrastructure may retain operational logs; do not treat hosted mode as offline or end-to-end encrypted.

## Online data boundary

Anonymous visitors can read and export only the bundled public example. Signing in creates access to a private, initially empty ledger. The backend derives ownership from gateway-authenticated identity, never a submitted owner ID. Every record, download, and export uses that ownership boundary. Signing out returns to the public example. Publishing application code does not publish users' stored research.

Each account is limited to 900 KB of structured JSON, 100 MB of snapshot reservations, and 25 MB per source. Reservations for failed or interrupted saves still count, preventing quota bypass through abandoned uploads. There is no self-service cleanup or whole-workspace deletion interface yet. Local and cloud data do not sync; existing local research is not automatically uploaded.

The hosted API rejects cross-site writes, uses no-store response headers, and blocks framing. D1 revision checks reject overlapping writes rather than silently losing one. A signed-in researcher can still open an unsafe source file after downloading it; files are delivered as attachments, not executed inside the workspace.

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

The public online site cannot read a local ledger. Use `npm run dev:full` or a standalone build served by Python to work with local records.

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

Both URL importers use these safeguards:

- accepts only `http` and `https`;
- resolves the hostname and rejects loopback, link-local, private, reserved, multicast, unspecified, IPv4-mapped, 6to4, Teredo, and NAT64 addresses;
- validates every redirect before following it;
- accepts only PDF, HTML, XHTML, and plain text;
- refuses responses larger than 25 MB;
- uses finite connection/read timeouts.

Manual citations and upload metadata reject URLs containing embedded usernames or passwords so credentials cannot be copied into an export.

The hosted importer checks public DNS responses before each fetch but does not pin the network connection to those addresses. This is a DNS-rebinding limitation; it is not equivalent to network-level isolation. Hosted mode has no private-network/VPC binding. These checks reduce server-side request forgery risk but are not a substitute for a hardened network sandbox.

The SQLite ledger is not cryptographically signed. Export performs defensive consistency checks, but an operator with direct database write access can alter provenance fields. Treat filesystem access as trusted and verify publication-critical citations against the original records.

## Human and machine boundary

The MVP does not call an AI model. The database reserves machine suggestions in a separate table with an `unverified` state. They cannot become evidence without an explicit human action and are excluded from exports. A generated paraphrase must never be entered as an exact source passage.

## Threat-model limits

Hosted mode provides account-scoped authorization, but neither edition provides end-to-end encryption, signed audit logs, malware scanning, collaborative editing, or a backup-restore interface. The local service has no account system and is intended for one researcher on a trusted machine. For sensitive work:

- use full-disk encryption and an encrypted backup;
- keep the service on loopback;
- inspect uploaded files with trusted security tooling;
- use a separate scoped instance when only part of a ledger should be shared, then review the entire export bundle;
- verify citation text against the original source before publication;
- do not publish the `instance/` directory or expose the API directly to the internet.
