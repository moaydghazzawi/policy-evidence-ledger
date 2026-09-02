'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  Download,
  ExternalLink,
  FileCheck2,
  FileText,
  GitCompareArrows,
  History,
  Library,
  Link2,
  LockKeyhole,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Upload,
} from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  NativeSelect,
  NativeSelectOption,
} from '@/components/ui/native-select';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Textarea } from '@/components/ui/textarea';
import {
  ApiError,
  approveEvidence,
  createClaim,
  createComparison,
  createDecision,
  createDefinition,
  createEvidence,
  createSource,
  downloadExport,
  loadDashboard,
  uploadSource,
  verifySource,
} from '@/lib/ledger-api';
import {
  fallbackDashboard,
  type Claim,
  type Dashboard,
  type Evidence,
  type Source,
} from '@/lib/ledger-types';

type ViewId =
  | 'desk'
  | 'sources'
  | 'claims'
  | 'definitions'
  | 'comparisons'
  | 'decisions'
  | 'export';
type DialogId =
  | 'source'
  | 'claim'
  | 'evidence'
  | 'approval'
  | 'definition'
  | 'comparison'
  | 'decision'
  | null;

type ModelContext = {
  registerTool: (
    tool: {
      name: string;
      title: string;
      description: string;
      inputSchema: Record<string, unknown>;
      annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
      execute: (input: unknown) => Promise<unknown>;
    },
    options?: { signal?: AbortSignal },
  ) => void | Promise<void>;
};

const workflow = [
  'Add source',
  'Verify metadata',
  'Capture claim',
  'Record evidence',
  'Add counterevidence',
  'Compare cases',
  'Export',
];

const navigation: Array<{
  id: ViewId;
  label: string;
  icon: typeof Library;
}> = [
  { id: 'desk', label: 'Research desk', icon: Library },
  { id: 'sources', label: 'Sources', icon: BookOpen },
  { id: 'claims', label: 'Claims', icon: FileCheck2 },
  { id: 'definitions', label: 'Definitions', icon: FileText },
  { id: 'comparisons', label: 'Comparisons', icon: GitCompareArrows },
  { id: 'decisions', label: 'Decision log', icon: History },
  { id: 'export', label: 'Export', icon: Download },
];

const sourceTypes = [
  ['government_rule', 'Government rule'],
  ['official_statement', 'Official statement'],
  ['legislation', 'Legislation'],
  ['court_record', 'Court record'],
  ['dataset', 'Dataset'],
  ['research_paper', 'Research paper'],
  ['report', 'Report'],
  ['news', 'News'],
  ['manual_citation', 'Manual citation'],
  ['other', 'Other'],
];

function formatDate(value: string | null | undefined): string {
  if (!value) return 'No date';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = dateOnly
    ? new Date(
        Number(dateOnly[1]),
        Number(dateOnly[2]) - 1,
        Number(dateOnly[3]),
      )
    : new Date(value);
  return Number.isNaN(date.valueOf())
    ? value
    : new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(date);
}

function statusTone(status: string): string {
  switch (status) {
    case 'supported':
      return 'border-emerald-700/20 bg-emerald-50 text-emerald-900';
    case 'contested':
      return 'border-amber-700/20 bg-amber-50 text-amber-900';
    case 'rejected':
      return 'border-rose-700/20 bg-rose-50 text-rose-900';
    default:
      return 'border-slate-500/20 bg-slate-50 text-slate-800';
  }
}

function sentenceCase(value: string): string {
  return value
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
}

function Field({
  id,
  label,
  hint,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>
        {label} {required ? <span aria-hidden="true">*</span> : null}
      </Label>
      {children}
      {hint ? (
        <p
          id={`${id}-hint`}
          className="text-xs leading-5 text-muted-foreground"
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function ViewHeader({
  eyebrow,
  title,
  description,
  action,
}: {
  eyebrow: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.14em] text-primary/70">
          <span className="h-px w-6 bg-primary/40" />
          {eyebrow}
        </p>
        <h1 className="max-w-4xl font-heading text-2xl font-semibold tracking-[-0.025em] sm:text-3xl">
          {title}
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-6 text-muted-foreground sm:text-[15px]">
          {description}
        </p>
      </div>
      {action}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card/50 px-5 py-12 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}

function DeskView({
  dashboard,
  setView,
}: {
  dashboard: Dashboard;
  setView: (view: ViewId) => void;
}) {
  const claim = dashboard.claims[0];
  const supporting = claim?.evidence.find((item) => item.role === 'supporting');
  const counter = dashboard.claims
    .flatMap((item) => item.evidence)
    .find((item) => item.role === 'counterevidence');

  return (
    <>
      <ViewHeader
        eyebrow="Research desk"
        title="Trace each conclusion back to the record."
        description="Keep source text, interpretation, uncertainty, and changes in judgment visibly separate from one another."
        action={
          <Button variant="outline" size="lg" onClick={() => setView('export')}>
            Review export readiness
            <ArrowRight aria-hidden="true" data-icon="inline-end" />
          </Button>
        }
      />

      <ol
        aria-label="Evidence workflow"
        className="mt-6 grid overflow-hidden rounded-lg border border-border bg-card shadow-sm sm:grid-cols-4 xl:grid-cols-7"
      >
        {workflow.map((step, index) => (
          <li
            key={step}
            className={`relative flex min-h-[68px] items-center gap-2.5 border-b border-border px-3 py-3 last:border-b-0 sm:border-b-0 sm:border-r sm:last:border-r-0 ${
              index === 0 ? 'bg-primary/[0.045]' : ''
            }`}
          >
            <span
              className={`grid size-6 shrink-0 place-items-center rounded-full border text-[11px] font-semibold ${
                index === 0
                  ? 'border-primary bg-primary text-primary-foreground'
                  : 'border-border bg-muted text-muted-foreground'
              }`}
            >
              {index === 0 ? <CircleDot className="size-3" /> : index + 1}
            </span>
            <span className="text-xs font-medium leading-tight">{step}</span>
            {index < workflow.length - 1 ? (
              <ChevronRight
                aria-hidden="true"
                className="absolute right-1 hidden size-3 text-border xl:block"
              />
            ) : null}
          </li>
        ))}
      </ol>

      <section
        aria-label="Current research record"
        className="mt-6 grid gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.8fr)]"
      >
        {claim ? (
          <Card className="rounded-lg border-0 bg-card shadow-[0_1px_0_rgb(30_41_59/8%),0_8px_30px_rgb(30_41_59/5%)] ring-1 ring-border">
            <CardHeader className="border-b border-border/80 pb-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline" className={statusTone(claim.status)}>
                  {sentenceCase(claim.status)}
                </Badge>
                <span className="font-mono text-[11px] text-muted-foreground">
                  {claim.id}
                </span>
              </div>
              <CardTitle className="mt-2 max-w-3xl text-lg leading-7">
                {claim.claim_text}
              </CardTitle>
              <CardDescription>
                Outcome: {claim.policy_outcome} · Confidence: {claim.confidence}
              </CardDescription>
              <CardAction>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setView('claims')}
                >
                  Open claim
                </Button>
              </CardAction>
            </CardHeader>
            <CardContent className="space-y-5 pt-1">
              <div className="grid gap-4 md:grid-cols-2">
                <div className="rounded-md border border-emerald-900/10 bg-emerald-50/65 p-4">
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-emerald-900">
                    <Check aria-hidden="true" className="size-3.5" /> Supporting
                    record
                  </p>
                  <p className="mt-3 text-sm leading-6 text-foreground/85">
                    {supporting?.exact_text ??
                      'No supporting evidence recorded.'}
                  </p>
                  <p className="mt-3 font-mono text-[11px] leading-5 text-muted-foreground">
                    {supporting?.source_id ?? '—'} ·{' '}
                    {supporting?.locator ?? 'Locator required'}
                  </p>
                </div>
                <div className="rounded-md border border-rose-900/10 bg-rose-50/55 p-4">
                  <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.1em] text-rose-900">
                    <GitCompareArrows aria-hidden="true" className="size-3.5" />{' '}
                    Counterevidence
                  </p>
                  <p className="mt-3 text-sm leading-6 text-foreground/85">
                    {counter?.exact_text ?? 'No counterevidence recorded.'}
                  </p>
                  <p className="mt-3 font-mono text-[11px] leading-5 text-muted-foreground">
                    {counter?.source_id ?? '—'} ·{' '}
                    {counter?.locator ?? 'Locator required'}
                  </p>
                </div>
              </div>
              <div className="grid gap-4 border-t border-border pt-5 md:grid-cols-3">
                <div>
                  <p className="evidence-label">Interpretation</p>
                  <p className="mt-1.5 text-sm leading-5">
                    {claim.interpretation}
                  </p>
                </div>
                <div>
                  <p className="evidence-label">Known limitation</p>
                  <p className="mt-1.5 text-sm leading-5">
                    {claim.known_limitation}
                  </p>
                </div>
                <div>
                  <p className="evidence-label">Traceability</p>
                  <p className="mt-1.5 text-sm leading-5">
                    {
                      claim.evidence.filter(
                        (item) => item.review_state === 'approved',
                      ).length
                    }{' '}
                    approved, located record(s).
                  </p>
                </div>
              </div>
            </CardContent>
          </Card>
        ) : (
          <EmptyState>
            Add the first claim to begin the evidence ledger.
          </EmptyState>
        )}

        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
          <Card className="rounded-lg border-0 ring-1 ring-border">
            <CardHeader className="border-b border-border/80 pb-4">
              <CardTitle>Source integrity</CardTitle>
              <CardDescription>
                Export gates are enforced below the interface.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {[
                [
                  'Metadata verified',
                  `${dashboard.sources.filter((source) => source.metadata_status === 'verified').length} of ${dashboard.sources.length}`,
                ],
                [
                  'Located evidence',
                  String(
                    dashboard.claims
                      .flatMap((item) => item.evidence)
                      .filter((item) => item.locator).length,
                  ),
                ],
                [
                  'Snapshot hashes captured',
                  `${dashboard.sources.filter((source) => source.document_hash).length}`,
                ],
              ].map(([label, value]) => (
                <div
                  key={label}
                  className="flex items-center justify-between gap-4"
                >
                  <span className="text-sm text-muted-foreground">{label}</span>
                  <span className="font-mono text-xs font-semibold">
                    {value}
                  </span>
                </div>
              ))}
              <div
                className={`rounded-md border p-3 text-xs leading-5 ${
                  dashboard.export_ready
                    ? 'border-emerald-200 bg-emerald-50 text-emerald-950'
                    : 'border-amber-200 bg-amber-50 text-amber-950'
                }`}
              >
                {dashboard.export_ready
                  ? 'All current claims pass the provenance gate.'
                  : (dashboard.export_issues[0] ??
                    'Add a claim before exporting.')}
              </div>
            </CardContent>
          </Card>

          <Card className="rounded-lg border-0 ring-1 ring-border">
            <CardHeader>
              <CardTitle>Recent decision</CardTitle>
              <CardDescription>
                {dashboard.decisions[0]
                  ? formatDate(dashboard.decisions[0].created_at)
                  : 'No changes yet'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-6">
                {dashboard.decisions[0]?.rationale ??
                  'Changes to claims and definitions will appear here with their rationale.'}
              </p>
              <button
                type="button"
                onClick={() => setView('decisions')}
                className="mt-4 inline-flex items-center gap-1 text-xs font-semibold text-primary hover:underline"
              >
                View decision log{' '}
                <ChevronRight aria-hidden="true" className="size-3" />
              </button>
            </CardContent>
          </Card>
        </div>
      </section>
    </>
  );
}

function SourcesView({
  sources,
  query,
  connected,
  onAdd,
  onVerify,
}: {
  sources: Source[];
  query: string;
  connected: boolean;
  onAdd: () => void;
  onVerify: (sourceId: string) => void;
}) {
  const filtered = sources.filter((source) =>
    `${source.title} ${source.author_institution}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <ViewHeader
        eyebrow="Source register"
        title="Preserve the source before interpreting it."
        description="Capture bibliographic metadata, access date, immutable bytes when available, and a verified status before approving evidence."
        action={
          <Button size="lg" onClick={onAdd} disabled={!connected}>
            <Plus aria-hidden="true" data-icon="inline-start" /> Add source
          </Button>
        }
      />
      <Card className="mt-6 rounded-lg border-0 ring-1 ring-border">
        <Table>
          <TableCaption className="px-4 pb-4 text-left">
            {filtered.length} source record(s). Citation-only records explicitly
            show when a document hash is unavailable.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-72 px-4">Source</TableHead>
              <TableHead>Published</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Integrity</TableHead>
              <TableHead className="pr-4 text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((source) => (
              <TableRow key={source.id}>
                <TableCell className="max-w-xl whitespace-normal px-4 py-4 align-top">
                  <p className="font-medium leading-5">{source.title}</p>
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    {source.author_institution} ·{' '}
                    <span className="font-mono">{source.id}</span>
                  </p>
                  {source.url ? (
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noreferrer"
                      className="mt-1 inline-flex items-center gap-1 text-xs text-primary hover:underline"
                    >
                      Open public source{' '}
                      <ExternalLink aria-hidden="true" className="size-3" />
                    </a>
                  ) : null}
                  {source.previous_version_id ? (
                    <p className="mt-1 text-xs text-muted-foreground">
                      Latest same-URL content transition follows{' '}
                      <span className="font-mono">
                        {source.previous_version_id}
                      </span>
                    </p>
                  ) : null}
                  {source.aliases?.length ? (
                    <details className="mt-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer font-medium text-foreground">
                        {source.aliases.length} identical-byte citation{' '}
                        {source.aliases.length === 1 ? 'alias' : 'aliases'}
                      </summary>
                      <ul className="mt-1 space-y-1 pl-4">
                        {source.aliases.map((alias) => (
                          <li key={alias.id}>
                            {alias.title ?? 'Untitled citation'} ·{' '}
                            {alias.access_date
                              ? `accessed ${alias.access_date}`
                              : 'access date unavailable'}
                            {alias.url ? ` · ${alias.url}` : ''}
                            {' · '}
                            {alias.metadata_status
                              ? `${sentenceCase(alias.metadata_status)} alias metadata (non-canonical)`
                              : 'Alias metadata status unavailable (non-canonical)'}
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                </TableCell>
                <TableCell className="align-top">
                  {formatDate(source.publication_date)}
                </TableCell>
                <TableCell className="align-top">
                  {sentenceCase(source.source_type)}
                </TableCell>
                <TableCell className="align-top">
                  <Badge
                    variant="outline"
                    className={
                      source.metadata_status === 'verified'
                        ? 'border-emerald-700/20 bg-emerald-50 text-emerald-900'
                        : 'border-amber-700/20 bg-amber-50 text-amber-900'
                    }
                  >
                    {sentenceCase(source.metadata_status)}
                  </Badge>
                  <p className="mt-2 max-w-52 break-all font-mono text-[10px] leading-4 text-muted-foreground">
                    {source.document_hash
                      ? `sha256:${source.document_hash}`
                      : 'Hash unavailable: citation-only'}
                  </p>
                </TableCell>
                <TableCell className="pr-4 text-right align-top">
                  {source.metadata_status === 'pending' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => onVerify(source.id)}
                      disabled={!connected}
                    >
                      Verify metadata
                    </Button>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-xs text-emerald-800">
                      <CheckCircle2 aria-hidden="true" className="size-3.5" />{' '}
                      Reviewed
                    </span>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

function ClaimsView({
  dashboard,
  query,
  connected,
  onAddClaim,
  onAddEvidence,
  onApproveEvidence,
}: {
  dashboard: Dashboard;
  query: string;
  connected: boolean;
  onAddClaim: () => void;
  onAddEvidence: () => void;
  onApproveEvidence: (evidence: Evidence) => void;
}) {
  const claims = dashboard.claims.filter((claim) =>
    `${claim.claim_text} ${claim.interpretation} ${claim.policy_outcome}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <>
      <ViewHeader
        eyebrow="Claim cards"
        title="Make the reasoning inspectable."
        description="Every card separates the policy claim, source passage or researcher-entered data point, interpretation, confidence, limitation, and counterevidence."
        action={
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              size="lg"
              onClick={onAddEvidence}
              disabled={!connected}
            >
              Add evidence
            </Button>
            <Button size="lg" onClick={onAddClaim} disabled={!connected}>
              <Plus aria-hidden="true" data-icon="inline-start" /> Capture claim
            </Button>
          </div>
        }
      />
      <div className="mt-6 space-y-5">
        {claims.map((claim) => (
          <ClaimCard
            key={claim.id}
            claim={claim}
            sources={dashboard.sources}
            connected={connected}
            onApproveEvidence={onApproveEvidence}
          />
        ))}
        {!claims.length ? (
          <EmptyState>No claims match this search.</EmptyState>
        ) : null}
      </div>
    </>
  );
}

function ClaimCard({
  claim,
  sources,
  connected,
  onApproveEvidence,
}: {
  claim: Claim;
  sources: Source[];
  connected: boolean;
  onApproveEvidence: (evidence: Evidence) => void;
}) {
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  return (
    <Card className="rounded-lg border-0 ring-1 ring-border">
      <CardHeader className="border-b border-border pb-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className={statusTone(claim.status)}>
            {sentenceCase(claim.status)}
          </Badge>
          <Badge variant="outline">Confidence: {claim.confidence}</Badge>
          <span className="font-mono text-[11px] text-muted-foreground">
            {claim.id}
          </span>
        </div>
        <CardTitle className="mt-2 text-lg leading-7">
          {claim.claim_text}
        </CardTitle>
        <CardDescription>
          {claim.case_name || 'No case assigned'} ·{' '}
          {claim.time_period || 'No period assigned'} · {claim.policy_outcome}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <p className="evidence-label">Researcher interpretation</p>
            <p className="mt-2 text-sm leading-6">{claim.interpretation}</p>
          </div>
          <div>
            <p className="evidence-label">Known limitation</p>
            <p className="mt-2 text-sm leading-6">{claim.known_limitation}</p>
          </div>
        </div>
        <div className="space-y-3 border-t border-border pt-5">
          <p className="evidence-label">Located source records</p>
          {claim.evidence.map((evidence) => {
            const source = sourceById.get(evidence.source_id);
            return (
              <article
                key={evidence.id}
                className={`rounded-md border p-4 ${
                  evidence.role === 'counterevidence'
                    ? 'border-rose-900/10 bg-rose-50/55'
                    : 'border-emerald-900/10 bg-emerald-50/60'
                }`}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline" className="bg-white/60">
                    {sentenceCase(evidence.role)}
                  </Badge>
                  <Badge variant="outline" className="bg-white/60">
                    {sentenceCase(evidence.review_state)}
                  </Badge>
                  <Badge variant="outline" className="bg-white/60">
                    {evidence.kind === 'passage'
                      ? 'Exact passage'
                      : 'Researcher-entered data point'}
                  </Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {evidence.id}
                  </span>
                </div>
                {evidence.kind === 'passage' ? (
                  <blockquote className="mt-3 border-l-2 border-primary/25 pl-3 text-sm leading-6">
                    {evidence.exact_text}
                  </blockquote>
                ) : (
                  <p className="mt-3 text-sm leading-6">
                    {evidence.exact_text}
                  </p>
                )}
                <p className="mt-3 text-xs leading-5 text-muted-foreground">
                  {source?.title ?? evidence.source_id} ·{' '}
                  {evidence.locator_type ?? 'No locator type'}:{' '}
                  {evidence.locator ?? 'locator required'}
                </p>
                {evidence.reviewer_note ? (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    Review note: {evidence.reviewer_note}
                  </p>
                ) : null}
                {evidence.review_state === 'draft' ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="mt-3"
                    disabled={!connected}
                    onClick={() => onApproveEvidence(evidence)}
                  >
                    Review and approve
                  </Button>
                ) : null}
              </article>
            );
          })}
          {!claim.evidence.length ? (
            <p className="text-sm text-muted-foreground">
              No evidence has been recorded yet.
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}

function DefinitionsView({
  dashboard,
  connected,
  onAdd,
}: {
  dashboard: Dashboard;
  connected: boolean;
  onAdd: () => void;
}) {
  return (
    <>
      <ViewHeader
        eyebrow="Working definitions"
        title="Record when the meaning changes."
        description="Definitions are versioned rather than overwritten, and every revision rationale is preserved in the decision log."
        action={
          <Button size="lg" onClick={onAdd} disabled={!connected}>
            <Plus aria-hidden="true" data-icon="inline-start" /> Add or revise
          </Button>
        }
      />
      <div className="mt-6 grid gap-5 lg:grid-cols-2">
        {dashboard.definitions.map((definition) => (
          <Card
            key={definition.id}
            className="rounded-lg border-0 ring-1 ring-border"
          >
            <CardHeader className="border-b border-border pb-4">
              <div className="flex items-center gap-2">
                <Badge variant="outline">Version {definition.version}</Badge>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {definition.definition_id}
                </span>
              </div>
              <CardTitle className="mt-2 text-xl">{definition.term}</CardTitle>
              <CardDescription>{definition.scope}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm leading-6">{definition.definition}</p>
              <div className="rounded-md bg-muted/70 p-3">
                <p className="evidence-label">Why this version exists</p>
                <p className="mt-1.5 text-sm leading-5">
                  {definition.rationale}
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </>
  );
}

function ComparisonsView({
  dashboard,
  connected,
  onAdd,
}: {
  dashboard: Dashboard;
  connected: boolean;
  onAdd: () => void;
}) {
  const claimById = new Map(dashboard.claims.map((claim) => [claim.id, claim]));
  return (
    <>
      <ViewHeader
        eyebrow="Contradiction matrix"
        title="Classify disagreement instead of flattening it."
        description="Distinguish genuine conflict from different definitions, different time periods, or mixed evidence. Relationships are classified by a human reviewer."
        action={
          <Button
            size="lg"
            onClick={onAdd}
            disabled={!connected || dashboard.claims.length < 2}
          >
            <Plus aria-hidden="true" data-icon="inline-start" /> Compare claims
          </Button>
        }
      />
      <Card className="mt-6 rounded-lg border-0 ring-1 ring-border">
        <Table>
          <TableCaption className="px-4 pb-4 text-left">
            Human-classified relationships between claims. No automated
            contradiction score is used.
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="min-w-64 px-4">Claim A</TableHead>
              <TableHead className="min-w-64">Claim B</TableHead>
              <TableHead>Relationship</TableHead>
              <TableHead className="min-w-72 pr-4">Rationale</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {dashboard.comparisons.map((comparison) => (
              <TableRow key={comparison.id}>
                <TableCell className="whitespace-normal px-4 py-4 align-top">
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {comparison.claim_a_id}
                  </p>
                  <p className="mt-1 leading-5">
                    {claimById.get(comparison.claim_a_id)?.claim_text}
                  </p>
                </TableCell>
                <TableCell className="whitespace-normal py-4 align-top">
                  <p className="font-mono text-[10px] text-muted-foreground">
                    {comparison.claim_b_id}
                  </p>
                  <p className="mt-1 leading-5">
                    {claimById.get(comparison.claim_b_id)?.claim_text}
                  </p>
                </TableCell>
                <TableCell className="align-top">
                  <Badge variant="outline">
                    {sentenceCase(comparison.relation)}
                  </Badge>
                </TableCell>
                <TableCell className="whitespace-normal pr-4 align-top leading-5">
                  {comparison.rationale}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}

function DecisionsView({
  dashboard,
  connected,
  onAdd,
}: {
  dashboard: Dashboard;
  connected: boolean;
  onAdd: () => void;
}) {
  return (
    <>
      <ViewHeader
        eyebrow="Research-decision log"
        title="Keep the changes in your thinking."
        description="A conclusion is more credible when the record shows what changed, why it changed, and which entity was affected."
        action={
          <Button size="lg" onClick={onAdd} disabled={!connected}>
            <Plus aria-hidden="true" data-icon="inline-start" /> Record decision
          </Button>
        }
      />
      <div className="relative mt-7 space-y-5 before:absolute before:bottom-3 before:left-[11px] before:top-3 before:w-px before:bg-border">
        {dashboard.decisions.map((decision) => (
          <article
            key={decision.id}
            className="relative grid grid-cols-[24px_minmax(0,1fr)] gap-4"
          >
            <span className="z-10 mt-5 size-6 rounded-full border-4 border-background bg-primary" />
            <Card className="rounded-lg border-0 ring-1 ring-border">
              <CardHeader className="border-b border-border pb-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant="outline">
                    {sentenceCase(decision.entity_type)}
                  </Badge>
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {decision.entity_id}
                  </span>
                </div>
                <CardTitle className="mt-2 text-base">
                  {decision.rationale}
                </CardTitle>
                <CardDescription>
                  {formatDate(decision.created_at)}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="evidence-label">Before</p>
                  <p className="mt-1.5 text-sm leading-5">
                    {decision.before_state || 'No prior state'}
                  </p>
                </div>
                <div>
                  <p className="evidence-label">After</p>
                  <p className="mt-1.5 text-sm leading-5">
                    {decision.after_state}
                  </p>
                </div>
              </CardContent>
            </Card>
          </article>
        ))}
        {!dashboard.decisions.length ? (
          <EmptyState>No research decisions have been recorded.</EmptyState>
        ) : null}
      </div>
    </>
  );
}

function ExportView({
  dashboard,
  connected,
  busy,
  onExport,
}: {
  dashboard: Dashboard;
  connected: boolean;
  busy: boolean;
  onExport: () => void;
}) {
  const outputs = [
    'Citation-ready claim notes',
    'CSV evidence table',
    'Duplicate-retrieval metadata table',
    'Changed-URL version lineage table',
    'Case-comparison matrix',
    'Contradiction matrix',
    'Short policy-memo outline',
    'Source bibliography',
    'Cryptographic export manifest',
  ];
  return (
    <>
      <ViewHeader
        eyebrow="Research output"
        title="Export only what can be traced."
        description="The export service rechecks metadata, locators, approval state, and captured-source hashes before creating one auditable bundle."
      />
      <div className="mt-6 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card className="rounded-lg border-0 ring-1 ring-border">
          <CardHeader className="border-b border-border pb-4">
            <CardTitle>Bundle contents</CardTitle>
            <CardDescription>
              Readable notes plus machine-friendly tables.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-3 sm:grid-cols-2">
              {outputs.map((output) => (
                <li
                  key={output}
                  className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-sm"
                >
                  <FileCheck2
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-primary"
                  />
                  {output}
                </li>
              ))}
            </ul>
            <div className="mt-5 rounded-md border border-primary/15 bg-primary/[0.035] p-4">
              <p className="evidence-label">Trace contract</p>
              <p className="mt-2 text-sm leading-6">
                Every evidence row includes claim, evidence, and source IDs; URL
                and access date; locator type and value; exact source text or
                data; and the snapshot SHA-256 when bytes were captured.
              </p>
            </div>
          </CardContent>
        </Card>
        <Card className="h-fit rounded-lg border-0 ring-1 ring-border">
          <CardHeader>
            <div
              className={`mb-2 grid size-10 place-items-center rounded-full ${
                dashboard.export_ready
                  ? 'bg-emerald-100 text-emerald-800'
                  : 'bg-amber-100 text-amber-900'
              }`}
            >
              {dashboard.export_ready ? (
                <CheckCircle2 aria-hidden="true" className="size-5" />
              ) : (
                <AlertTriangle aria-hidden="true" className="size-5" />
              )}
            </div>
            <CardTitle>
              {dashboard.export_ready
                ? 'Ready to export'
                : 'Provenance review required'}
            </CardTitle>
            <CardDescription>
              {dashboard.export_ready
                ? `${dashboard.claims.length} claim(s) pass the current gate.`
                : 'Resolve every issue before any file is written.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {dashboard.export_issues.length ? (
              <ul className="space-y-2 text-sm text-amber-950">
                {dashboard.export_issues.map((issue) => (
                  <li key={issue} className="rounded-md bg-amber-50 p-2.5">
                    {issue}
                  </li>
                ))}
              </ul>
            ) : null}
            <Button
              size="lg"
              className="w-full"
              onClick={onExport}
              disabled={!connected || !dashboard.export_ready || busy}
            >
              {busy ? (
                <RefreshCw
                  aria-hidden="true"
                  className="animate-spin"
                  data-icon="inline-start"
                />
              ) : (
                <Download aria-hidden="true" data-icon="inline-start" />
              )}
              Download research bundle
            </Button>
            {!connected ? (
              <p className="text-xs leading-5 text-muted-foreground">
                Start the local Python service to generate a real export. This
                static preview does not write data.
              </p>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function DialogMutationError({ message }: { message: string }) {
  return message ? (
    <Alert role="alert" variant="destructive">
      <AlertTriangle aria-hidden="true" />
      <AlertTitle>Could not complete that step</AlertTitle>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null;
}

function SourceDialog({
  open,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  const [mode, setMode] = useState('url');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add a public source</DialogTitle>
          <DialogDescription>
            Capture a URL, local PDF/HTML/text file, or manual citation. New
            metadata begins unverified unless it comes from the reviewed demo
            corpus.
          </DialogDescription>
        </DialogHeader>
        <DialogMutationError message={error} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(event.currentTarget);
          }}
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="source-mode" label="Ingestion mode" required>
              <NativeSelect
                id="source-mode"
                name="ingest_mode"
                value={mode}
                onChange={(event) => setMode(event.target.value)}
                className="w-full"
              >
                <NativeSelectOption value="url">Fetch URL</NativeSelectOption>
                <NativeSelectOption value="upload">
                  Upload PDF / HTML / text
                </NativeSelectOption>
                <NativeSelectOption value="manual">
                  Manual citation
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field id="source-type" label="Source type" required>
              <NativeSelect
                id="source-type"
                name="source_type"
                className="w-full"
                required
              >
                {sourceTypes.map(([value, label]) => (
                  <NativeSelectOption key={value} value={value}>
                    {label}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          </div>
          <Field id="source-title" label="Title" required>
            <Input id="source-title" name="title" required maxLength={500} />
          </Field>
          <Field id="source-author" label="Author or institution" required>
            <Input
              id="source-author"
              name="author_institution"
              required
              maxLength={300}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="source-date" label="Publication date">
              <Input id="source-date" name="publication_date" type="date" />
            </Field>
            <Field id="source-language" label="Language">
              <Input
                id="source-language"
                name="language"
                defaultValue="en"
                maxLength={20}
              />
            </Field>
          </div>
          {mode === 'upload' ? (
            <Field
              id="source-file"
              label="Local file"
              required
              hint="Maximum 25 MB. The original bytes are hashed before any parsing."
            >
              <Input
                id="source-file"
                name="file"
                type="file"
                required
                aria-describedby="source-file-hint"
                accept="application/pdf,text/html,application/xhtml+xml,text/plain,.pdf,.html,.htm,.txt"
                className="h-10 pt-1.5"
              />
            </Field>
          ) : null}
          <Field
            id="source-url"
            label={
              mode === 'url'
                ? 'Public URL'
                : mode === 'upload'
                  ? 'Public/source URL (optional)'
                  : 'URL (optional)'
            }
            required={mode === 'url'}
            hint={
              mode === 'url'
                ? 'Only public HTTP(S) addresses are fetched; private networks are blocked.'
                : mode === 'upload'
                  ? 'Preserved as citation metadata alongside the hashed local file.'
                  : undefined
            }
          >
            <Input
              id="source-url"
              name="url"
              type="url"
              required={mode === 'url'}
              aria-describedby={
                mode === 'url' || mode === 'upload'
                  ? 'source-url-hint'
                  : undefined
              }
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {mode === 'upload' ? (
                <Upload aria-hidden="true" data-icon="inline-start" />
              ) : (
                <Link2 aria-hidden="true" data-icon="inline-start" />
              )}
              Preserve source
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ClaimDialog({
  open,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Capture a structured claim</DialogTitle>
          <DialogDescription>
            Write the claim in plain language. Evidence is attached in a
            separate step so source text never blends into interpretation.
          </DialogDescription>
        </DialogHeader>
        <DialogMutationError message={error} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(event.currentTarget);
          }}
          className="space-y-4"
        >
          <Field id="claim-text" label="Claim in plain language" required>
            <Textarea id="claim-text" name="claim_text" required rows={3} />
          </Field>
          <Field
            id="claim-interpretation"
            label="Researcher interpretation"
            required
          >
            <Textarea
              id="claim-interpretation"
              name="interpretation"
              required
              rows={3}
            />
          </Field>
          <Field id="claim-limitation" label="Known limitation" required>
            <Textarea
              id="claim-limitation"
              name="known_limitation"
              required
              rows={2}
            />
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="claim-confidence" label="Confidence" required>
              <NativeSelect
                id="claim-confidence"
                name="confidence"
                className="w-full"
                defaultValue="moderate"
              >
                <NativeSelectOption value="low">Low</NativeSelectOption>
                <NativeSelectOption value="moderate">
                  Moderate
                </NativeSelectOption>
                <NativeSelectOption value="high">High</NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field id="claim-status" label="Status" required>
              <NativeSelect
                id="claim-status"
                name="status"
                className="w-full"
                defaultValue="unclear"
              >
                <NativeSelectOption value="supported">
                  Supported
                </NativeSelectOption>
                <NativeSelectOption value="contested">
                  Contested
                </NativeSelectOption>
                <NativeSelectOption value="unclear">Unclear</NativeSelectOption>
                <NativeSelectOption value="rejected">
                  Rejected
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field id="claim-outcome" label="Policy outcome" required>
              <Input id="claim-outcome" name="policy_outcome" required />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field id="claim-case" label="Case">
              <Input id="claim-case" name="case_name" />
            </Field>
            <Field id="claim-period" label="Time period">
              <Input
                id="claim-period"
                name="time_period"
                placeholder="e.g. 2022-2024"
              />
            </Field>
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Capture claim
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EvidenceDialog({
  open,
  busy,
  error,
  dashboard,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  dashboard: Dashboard;
  onOpenChange: (open: boolean) => void;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  const [reviewState, setReviewState] = useState('draft');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Record located evidence</DialogTitle>
          <DialogDescription>
            Enter exact source text or a specific data point. Approved evidence
            requires verified metadata and a page, section, paragraph, table,
            article, or other locator.
          </DialogDescription>
        </DialogHeader>
        <DialogMutationError message={error} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(event.currentTarget);
          }}
          className="space-y-4"
        >
          <Field id="evidence-claim" label="Claim" required>
            <NativeSelect
              id="evidence-claim"
              name="claim_id"
              className="w-full"
              required
            >
              <NativeSelectOption value="">Select a claim</NativeSelectOption>
              {dashboard.claims.map((claim) => (
                <NativeSelectOption key={claim.id} value={claim.id}>
                  {claim.id} — {claim.claim_text.slice(0, 70)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field id="evidence-source" label="Source" required>
            <NativeSelect
              id="evidence-source"
              name="source_id"
              className="w-full"
              required
            >
              <NativeSelectOption value="">Select a source</NativeSelectOption>
              {dashboard.sources.map((source) => (
                <NativeSelectOption key={source.id} value={source.id}>
                  {source.id} — {source.title.slice(0, 70)}
                  {source.metadata_status === 'pending' ? ' (unverified)' : ''}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field id="evidence-role" label="Role" required>
              <NativeSelect
                id="evidence-role"
                name="role"
                className="w-full"
                defaultValue="supporting"
              >
                <NativeSelectOption value="supporting">
                  Supporting
                </NativeSelectOption>
                <NativeSelectOption value="counterevidence">
                  Counterevidence
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field id="evidence-kind" label="Record type" required>
              <NativeSelect
                id="evidence-kind"
                name="kind"
                className="w-full"
                defaultValue="passage"
              >
                <NativeSelectOption value="passage">
                  Exact passage
                </NativeSelectOption>
                <NativeSelectOption value="data_point">
                  Data point
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field id="evidence-review" label="Review state" required>
              <NativeSelect
                id="evidence-review"
                name="review_state"
                className="w-full"
                value={reviewState}
                onChange={(event) => setReviewState(event.target.value)}
              >
                <NativeSelectOption value="draft">Draft</NativeSelectOption>
                <NativeSelectOption value="approved">
                  Approved
                </NativeSelectOption>
              </NativeSelect>
            </Field>
          </div>
          <Field
            id="evidence-text"
            label="Exact passage or data point"
            required
          >
            <Textarea id="evidence-text" name="exact_text" required rows={5} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
            <Field id="locator-type" label="Locator type">
              <NativeSelect
                id="locator-type"
                name="locator_type"
                className="w-full"
                defaultValue="section"
              >
                {[
                  'page',
                  'section',
                  'paragraph',
                  'table',
                  'article',
                  'timestamp',
                  'other',
                ].map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {sentenceCase(value)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field
              id="locator"
              label="Locator"
              required={reviewState === 'approved'}
              hint="Optional while drafting and required for approval; be specific enough for another researcher to find the record."
            >
              <Input
                id="locator"
                name="locator"
                required={reviewState === 'approved'}
                aria-describedby="locator-hint"
                placeholder="e.g. 87 FR 62186, Summary; p. 17; table 3"
              />
            </Field>
          </div>
          <Field id="reviewer-note" label="Reviewer note">
            <Input id="reviewer-note" name="reviewer_note" />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Record evidence
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function EvidenceApprovalDialog({
  open,
  busy,
  error,
  evidence,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  evidence: Evidence | null;
  onOpenChange: (open: boolean) => void;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Review and approve evidence</DialogTitle>
          <DialogDescription>
            Confirm a precise locator before this record becomes eligible for
            export. Approval still fails if the source metadata is unverified.
          </DialogDescription>
        </DialogHeader>
        <DialogMutationError message={error} />
        <form
          key={evidence?.id ?? 'no-evidence'}
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(event.currentTarget);
          }}
          className="space-y-4"
        >
          <p className="rounded-md bg-muted/70 p-3 text-sm leading-6">
            {evidence?.exact_text ?? 'Select a draft evidence record.'}
          </p>
          <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
            <Field id="approval-locator-type" label="Locator type" required>
              <NativeSelect
                id="approval-locator-type"
                name="locator_type"
                className="w-full"
                defaultValue={evidence?.locator_type ?? 'section'}
              >
                {[
                  'page',
                  'section',
                  'paragraph',
                  'table',
                  'article',
                  'timestamp',
                  'other',
                ].map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {sentenceCase(value)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field
              id="approval-locator"
              label="Locator"
              required
              hint="Use enough detail for another researcher to find the record."
            >
              <Input
                id="approval-locator"
                name="locator"
                required
                aria-describedby="approval-locator-hint"
                defaultValue={evidence?.locator ?? ''}
              />
            </Field>
          </div>
          <Field id="approval-reviewer-note" label="Reviewer note">
            <Input
              id="approval-reviewer-note"
              name="reviewer_note"
              defaultValue={evidence?.reviewer_note ?? ''}
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !evidence}>
              Approve evidence
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DefinitionDialog({
  open,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Add or revise a working definition</DialogTitle>
          <DialogDescription>
            Reusing an existing term creates a new version and automatically
            records the rationale.
          </DialogDescription>
        </DialogHeader>
        <DialogMutationError message={error} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(event.currentTarget);
          }}
          className="space-y-4"
        >
          <Field id="definition-term" label="Term" required>
            <Input id="definition-term" name="term" required />
          </Field>
          <Field id="definition-text" label="Working definition" required>
            <Textarea
              id="definition-text"
              name="definition"
              required
              rows={4}
            />
          </Field>
          <Field id="definition-scope" label="Scope" required>
            <Input id="definition-scope" name="scope" required />
          </Field>
          <Field
            id="definition-rationale"
            label="Why this definition or revision?"
            required
          >
            <Textarea
              id="definition-rationale"
              name="rationale"
              required
              rows={2}
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Save version
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ComparisonDialog({
  open,
  busy,
  error,
  claims,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  claims: Claim[];
  onOpenChange: (open: boolean) => void;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Classify a claim relationship</DialogTitle>
          <DialogDescription>
            Choose the relationship and explain it. The ledger never infers
            contradiction automatically.
          </DialogDescription>
        </DialogHeader>
        <DialogMutationError message={error} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(event.currentTarget);
          }}
          className="space-y-4"
        >
          {['claim_a_id', 'claim_b_id'].map((name, index) => (
            <Field
              key={name}
              id={name}
              label={`Claim ${index ? 'B' : 'A'}`}
              required
            >
              <NativeSelect id={name} name={name} className="w-full" required>
                <NativeSelectOption value="">Select a claim</NativeSelectOption>
                {claims.map((claim) => (
                  <NativeSelectOption key={claim.id} value={claim.id}>
                    {claim.id} — {claim.claim_text.slice(0, 70)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
          ))}
          <Field id="comparison-relation" label="Relationship" required>
            <NativeSelect
              id="comparison-relation"
              name="relation"
              className="w-full"
              defaultValue="mixed"
            >
              {[
                'agrees',
                'disagrees',
                'different_definition',
                'different_period',
                'mixed',
              ].map((value) => (
                <NativeSelectOption key={value} value={value}>
                  {sentenceCase(value)}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field id="comparison-rationale" label="Rationale" required>
            <Textarea
              id="comparison-rationale"
              name="rationale"
              required
              rows={3}
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Add to matrix
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DecisionDialog({
  open,
  busy,
  error,
  onOpenChange,
  onSubmit,
}: {
  open: boolean;
  busy: boolean;
  error: string;
  onOpenChange: (open: boolean) => void;
  onSubmit: (form: HTMLFormElement) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Record a research decision</DialogTitle>
          <DialogDescription>
            Preserve what changed and why. Use the affected record ID when one
            exists; case and conclusion changes may use a stable short label.
          </DialogDescription>
        </DialogHeader>
        <DialogMutationError message={error} />
        <form
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit(event.currentTarget);
          }}
          className="space-y-4"
        >
          <div className="grid gap-4 sm:grid-cols-[180px_minmax(0,1fr)]">
            <Field id="decision-type" label="Affected record type" required>
              <NativeSelect
                id="decision-type"
                name="entity_type"
                defaultValue="claim"
                className="w-full"
              >
                <NativeSelectOption value="claim">Claim</NativeSelectOption>
                <NativeSelectOption value="case">Case</NativeSelectOption>
                <NativeSelectOption value="conclusion">
                  Conclusion
                </NativeSelectOption>
                <NativeSelectOption value="definition">
                  Definition
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field
              id="decision-entity"
              label="Record ID or stable label"
              required
            >
              <Input id="decision-entity" name="entity_id" required />
            </Field>
          </div>
          <Field id="decision-before" label="Before">
            <Textarea id="decision-before" name="before_state" rows={2} />
          </Field>
          <Field id="decision-after" label="After" required>
            <Textarea
              id="decision-after"
              name="after_state"
              required
              rows={2}
            />
          </Field>
          <Field id="decision-rationale" label="Why did it change?" required>
            <Textarea
              id="decision-rationale"
              name="rationale"
              required
              rows={3}
            />
          </Field>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Record decision
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function formValues(form: HTMLFormElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of new FormData(form).entries()) {
    if (typeof value === 'string') result[key] = value;
  }
  return result;
}

export function LedgerWorkspace() {
  const [dashboard, setDashboard] = useState<Dashboard>(fallbackDashboard);
  const [connected, setConnected] = useState(false);
  const [view, setView] = useState<ViewId>('desk');
  const [dialog, setDialog] = useState<DialogId>(null);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [approvalTarget, setApprovalTarget] = useState<Evidence | null>(null);

  const changeDialog = (next: DialogId) => {
    setError('');
    setDialog(next);
  };

  const refresh = useCallback(async () => {
    try {
      const next = await loadDashboard();
      setDashboard(next);
      setConnected(true);
      setError('');
    } catch {
      setDashboard(fallbackDashboard);
      setConnected(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  useEffect(() => {
    const context = (document as Document & { modelContext?: ModelContext })
      .modelContext;
    if (!context?.registerTool) return;
    const lifecycle = new AbortController();
    void Promise.resolve(
      context.registerTool(
        {
          name: 'create_manual_source',
          title: 'Create manual source',
          description:
            'Create a pending manual citation in the visible Policy Evidence Ledger source register.',
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string' },
              author_institution: { type: 'string' },
              source_type: { type: 'string' },
              url: { type: 'string' },
              publication_date: { type: 'string' },
            },
            required: ['title', 'author_institution', 'source_type'],
            additionalProperties: false,
          },
          annotations: { readOnlyHint: false, untrustedContentHint: false },
          async execute(input) {
            if (!connected)
              throw new Error('The local Python service is not connected.');
            if (!input || typeof input !== 'object')
              throw new Error('Input must be an object.');
            const values = input as Record<string, unknown>;
            for (const key of ['title', 'author_institution', 'source_type']) {
              if (typeof values[key] !== 'string' || !values[key].trim()) {
                throw new Error(`${key} is required.`);
              }
            }
            const result = (await createSource({
              title: values.title,
              author_institution: values.author_institution,
              source_type: values.source_type,
              url: values.url || null,
              publication_date: values.publication_date || null,
              metadata_status: 'pending',
              ingest_mode: 'manual',
              language: 'en',
              notes:
                'Created through the browser tool surface; metadata requires human verification.',
            })) as { source: Source };
            await refresh();
            setView('sources');
            return {
              id: result.source.id,
              status: 'pending_metadata_verification',
            };
          },
        },
        { signal: lifecycle.signal },
      ),
    ).catch(() => undefined);
    return () => lifecycle.abort();
  }, [connected, refresh]);

  const counts = useMemo(
    () => ({
      sources: dashboard.sources.length,
      claims: dashboard.claims.length,
      definitions: dashboard.definitions.length,
      comparisons: dashboard.comparisons.length,
      decisions: dashboard.decisions.length,
    }),
    [dashboard],
  );

  const runMutation = async (
    action: () => Promise<unknown>,
    success: string | ((result: unknown) => string),
  ) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await action();
      await refresh();
      changeDialog(null);
      setNotice(typeof success === 'function' ? success(result) : success);
    } catch (caught) {
      const apiError = caught as ApiError;
      setError([apiError.message, ...(apiError.issues ?? [])].join(' · '));
    } finally {
      setBusy(false);
    }
  };

  const handleSource = (form: HTMLFormElement) => {
    const raw = new FormData(form);
    const rawMode = raw.get('ingest_mode');
    const mode = typeof rawMode === 'string' ? rawMode : 'manual';
    if (mode === 'upload') {
      raw.delete('ingest_mode');
      void runMutation(
        () => uploadSource(raw),
        (result) => {
          const payload = result as { source?: Source };
          return payload.source?.duplicate
            ? 'Identical source bytes already existed. Retrieval and citation metadata were preserved as an alias; no duplicate snapshot was created.'
            : 'Source bytes preserved; verify the metadata next.';
        },
      );
      return;
    }
    const values = formValues(form);
    void runMutation(
      () =>
        createSource({
          ...values,
          publication_date: values.publication_date || null,
          url: values.url || null,
          metadata_status: 'pending',
          notes: '',
        }),
      (result) => {
        const payload = result as {
          source?: Source;
          citation_duplicate_warning?: string[];
        };
        if (payload.source?.duplicate) {
          return 'Identical source bytes already existed. This URL was preserved as an alias.';
        }
        if (payload.citation_duplicate_warning?.length) {
          return `Citation saved with a possible duplicate warning: ${payload.citation_duplicate_warning.join(', ')}.`;
        }
        return mode === 'url'
          ? 'Public source fetched, hashed, and stored locally; verify the metadata next.'
          : 'Manual citation saved; verify the metadata next.';
      },
    );
  };

  const activeView = (() => {
    switch (view) {
      case 'sources':
        return (
          <SourcesView
            sources={dashboard.sources}
            query={query}
            connected={connected}
            onAdd={() => changeDialog('source')}
            onVerify={(sourceId) =>
              void runMutation(
                () => verifySource(sourceId),
                'Source metadata marked verified.',
              )
            }
          />
        );
      case 'claims':
        return (
          <ClaimsView
            dashboard={dashboard}
            query={query}
            connected={connected}
            onAddClaim={() => changeDialog('claim')}
            onAddEvidence={() => changeDialog('evidence')}
            onApproveEvidence={(evidence) => {
              setApprovalTarget(evidence);
              changeDialog('approval');
            }}
          />
        );
      case 'definitions':
        return (
          <DefinitionsView
            dashboard={dashboard}
            connected={connected}
            onAdd={() => changeDialog('definition')}
          />
        );
      case 'comparisons':
        return (
          <ComparisonsView
            dashboard={dashboard}
            connected={connected}
            onAdd={() => changeDialog('comparison')}
          />
        );
      case 'decisions':
        return (
          <DecisionsView
            dashboard={dashboard}
            connected={connected}
            onAdd={() => changeDialog('decision')}
          />
        );
      case 'export':
        return (
          <ExportView
            dashboard={dashboard}
            connected={connected}
            busy={busy}
            onExport={() =>
              void runMutation(downloadExport, 'Research bundle downloaded.')
            }
          />
        );
      default:
        return <DeskView dashboard={dashboard} setView={setView} />;
    }
  })();

  return (
    <div className="min-h-screen bg-background text-foreground">
      <a
        href="#workspace"
        className="sr-only z-[100] rounded bg-primary px-3 py-2 text-primary-foreground focus:not-sr-only focus:fixed focus:left-3 focus:top-3"
      >
        Skip to research workspace
      </a>
      <header className="sticky top-0 z-40 border-b border-border/90 bg-card/95 backdrop-blur">
        <div className="mx-auto flex h-16 max-w-[1600px] items-center gap-4 px-4 sm:px-6">
          <button
            type="button"
            onClick={() => setView('desk')}
            className="flex min-w-0 items-center gap-3 text-left"
          >
            <span className="grid size-9 shrink-0 place-items-center rounded-md border border-primary/20 bg-primary text-primary-foreground shadow-sm">
              <FileCheck2 aria-hidden="true" className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block truncate font-heading text-[15px] font-semibold tracking-tight">
                Policy Evidence Ledger
              </span>
              <span className="hidden text-xs text-muted-foreground sm:block">
                Local research workspace
              </span>
            </span>
          </button>
          {view === 'sources' || view === 'claims' ? (
            <label className="relative ml-auto hidden w-full max-w-md md:block">
              <span className="sr-only">
                Search {view === 'sources' ? 'sources' : 'claims'}
              </span>
              <Search
                aria-hidden="true"
                className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
              />
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={`Search ${view}`}
                className="h-9 w-full rounded-md border border-input bg-background pl-9 pr-3 text-sm outline-none transition"
              />
            </label>
          ) : (
            <span className="ml-auto" />
          )}
          <div className="ml-auto flex items-center gap-2 md:ml-2">
            <Badge
              variant="outline"
              className={
                connected
                  ? 'hidden border-emerald-700/20 bg-emerald-50 text-emerald-800 sm:inline-flex'
                  : 'hidden border-amber-700/20 bg-amber-50 text-amber-900 sm:inline-flex'
              }
            >
              {connected ? (
                <ShieldCheck aria-hidden="true" data-icon="inline-start" />
              ) : (
                <LockKeyhole aria-hidden="true" data-icon="inline-start" />
              )}
              {connected ? 'Local service connected' : 'Read-only demo preview'}
            </Badge>
            <Button
              size="lg"
              onClick={() => changeDialog('source')}
              disabled={!connected}
            >
              <Plus aria-hidden="true" data-icon="inline-start" /> Add source
            </Button>
          </div>
        </div>
        <nav
          aria-label="Research sections"
          className="overflow-x-auto border-t border-border/70 lg:hidden"
        >
          <div className="flex min-w-max gap-1 px-3 py-2">
            {navigation.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                onClick={() => setView(id)}
                aria-label={label}
                aria-current={view === id ? 'page' : undefined}
                className={`inline-flex items-center gap-2 rounded-md px-3 py-2 text-xs font-medium ${
                  view === id
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted'
                }`}
              >
                <Icon aria-hidden="true" className="size-3.5" /> {label}
              </button>
            ))}
          </div>
        </nav>
      </header>

      <div className="mx-auto grid max-w-[1600px] lg:grid-cols-[224px_minmax(0,1fr)]">
        <aside className="sticky top-16 hidden h-[calc(100vh-4rem)] border-r border-border/80 bg-sidebar px-3 py-5 lg:block">
          <nav aria-label="Research sections" className="space-y-1">
            {navigation.map(({ id, label, icon: Icon }) => {
              const count =
                id === 'desk' || id === 'export' ? undefined : counts[id];
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setView(id)}
                  aria-label={label}
                  aria-current={view === id ? 'page' : undefined}
                  className={`flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm ${
                    view === id
                      ? 'bg-sidebar-primary text-sidebar-primary-foreground shadow-sm'
                      : 'text-sidebar-foreground hover:bg-sidebar-accent'
                  }`}
                >
                  <Icon aria-hidden="true" className="size-4" />
                  <span className="flex-1">{label}</span>
                  {count !== undefined ? (
                    <span
                      className={
                        view === id
                          ? 'text-xs text-white/70'
                          : 'text-xs text-muted-foreground'
                      }
                    >
                      {count}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </nav>
          <div className="mt-8 border-t border-sidebar-border pt-5">
            <p className="px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Current ledger
            </p>
            <div className="mt-3 rounded-md border border-sidebar-border bg-card px-3 py-3 shadow-sm">
              <p className="text-sm font-medium leading-snug">
                Evidence-led policy research
              </p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Topic follows your source records
              </p>
            </div>
          </div>
          <div className="absolute bottom-5 left-3 right-3 rounded-md border border-sidebar-border bg-card/70 p-3 text-[11px] leading-5 text-muted-foreground">
            <p className="font-semibold text-foreground">
              Human review boundary
            </p>
            Machine suggestions never enter approved evidence or exports without
            explicit review.
          </div>
        </aside>

        <main
          id="workspace"
          className="min-w-0 px-4 py-6 sm:px-6 lg:px-8 lg:py-8"
        >
          <div className="mx-auto max-w-[1240px]">
            {!connected ? (
              <Alert className="mb-5 border-amber-200 bg-amber-50 text-amber-950">
                <LockKeyhole aria-hidden="true" />
                <AlertTitle>Read-only demonstration</AlertTitle>
                <AlertDescription className="text-amber-900/80">
                  The interface is showing a public sample corpus. Start the
                  local Python service to add, verify, compare, and export
                  records.
                </AlertDescription>
              </Alert>
            ) : null}
            {notice ? (
              <Alert className="mb-5 border-emerald-200 bg-emerald-50 text-emerald-950">
                <CheckCircle2 aria-hidden="true" />
                <AlertTitle>Saved</AlertTitle>
                <AlertDescription>{notice}</AlertDescription>
              </Alert>
            ) : null}
            {error ? (
              <Alert variant="destructive" className="mb-5">
                <AlertTriangle aria-hidden="true" />
                <AlertTitle>Could not complete that step</AlertTitle>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
            {activeView}
          </div>
        </main>
      </div>

      <SourceDialog
        open={dialog === 'source'}
        busy={busy}
        error={error}
        onOpenChange={(open) => changeDialog(open ? 'source' : null)}
        onSubmit={handleSource}
      />
      <ClaimDialog
        open={dialog === 'claim'}
        busy={busy}
        error={error}
        onOpenChange={(open) => changeDialog(open ? 'claim' : null)}
        onSubmit={(form) => {
          const values = formValues(form);
          void runMutation(
            () => createClaim(values),
            'Claim captured; attach located evidence next.',
          );
        }}
      />
      <EvidenceDialog
        key={dialog === 'evidence' ? 'evidence-open' : 'evidence-closed'}
        open={dialog === 'evidence'}
        busy={busy}
        error={error}
        dashboard={dashboard}
        onOpenChange={(open) => changeDialog(open ? 'evidence' : null)}
        onSubmit={(form) => {
          const values = formValues(form);
          void runMutation(
            () =>
              createEvidence({ ...values, locator: values.locator || null }),
            'Evidence record added with its review state and source locator.',
          );
        }}
      />
      <EvidenceApprovalDialog
        open={dialog === 'approval'}
        busy={busy}
        error={error}
        evidence={approvalTarget}
        onOpenChange={(open) => {
          changeDialog(open ? 'approval' : null);
          if (!open) setApprovalTarget(null);
        }}
        onSubmit={(form) => {
          if (!approvalTarget) return;
          const values = formValues(form);
          void runMutation(
            () => approveEvidence(approvalTarget.id, values),
            'Evidence approved after metadata and locator review.',
          );
        }}
      />
      <DefinitionDialog
        open={dialog === 'definition'}
        busy={busy}
        error={error}
        onOpenChange={(open) => changeDialog(open ? 'definition' : null)}
        onSubmit={(form) =>
          void runMutation(
            () => createDefinition(formValues(form)),
            'Definition version saved and change rationale recorded.',
          )
        }
      />
      <ComparisonDialog
        open={dialog === 'comparison'}
        busy={busy}
        error={error}
        claims={dashboard.claims}
        onOpenChange={(open) => changeDialog(open ? 'comparison' : null)}
        onSubmit={(form) =>
          void runMutation(
            () => createComparison(formValues(form)),
            'Human-classified relationship added to the contradiction matrix.',
          )
        }
      />
      <DecisionDialog
        open={dialog === 'decision'}
        busy={busy}
        error={error}
        onOpenChange={(open) => changeDialog(open ? 'decision' : null)}
        onSubmit={(form) =>
          void runMutation(
            () => createDecision(formValues(form)),
            'Research decision recorded with its before, after, and rationale.',
          )
        }
      />
    </div>
  );
}
