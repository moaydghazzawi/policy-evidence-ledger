'use client';

import {
  ArrowDownToLine,
  ArrowRight,
  BookOpen,
  Check,
  CheckCheck,
  FileText,
  GitCompareArrows,
  Plus,
  ShieldCheck,
} from 'lucide-react';
import type { Dashboard } from '@/lib/ledger-types';

type Section =
  | 'desk'
  | 'sources'
  | 'claims'
  | 'definitions'
  | 'comparisons'
  | 'decisions'
  | 'export';
const statusLabel = (value: string) =>
  value.charAt(0).toUpperCase() + value.slice(1);

export function ResearchOverview({
  dashboard,
  navigate,
  onAdd,
  editable,
}: {
  dashboard: Dashboard;
  navigate: (view: Section) => void;
  onAdd: () => void;
  editable: boolean;
}) {
  const evidence = dashboard.claims.flatMap((claim) => claim.evidence);
  const approved = evidence.filter(
    (item) => item.review_state === 'approved',
  ).length;
  const verified = dashboard.sources.filter(
    (item) => item.metadata_status === 'verified',
  ).length;
  const statusCounts = ['supported', 'contested', 'unclear', 'rejected'].map(
    (status) => ({
      status,
      count: dashboard.claims.filter((claim) => claim.status === status).length,
    }),
  );
  const recent = [...dashboard.decisions]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 3);
  return (
    <div className="overview">
      <div className="page-heading">
        <div>
          <div className="overline">YOUR RESEARCH, CONNECTED</div>
          <h1>Research overview</h1>
          <p>
            A clear view of your sources, claims, and the evidence between them.
          </p>
        </div>
        <button className="action-primary" onClick={onAdd} disabled={!editable}>
          <Plus size={17} /> Add source
        </button>
      </div>

      <section className="overview-stats" aria-label="Ledger summary">
        {[
          {
            title: 'Sources',
            value: dashboard.sources.length,
            detail: `${verified} verified`,
            icon: BookOpen,
            view: 'sources' as const,
          },
          {
            title: 'Claims',
            value: dashboard.claims.length,
            detail: `${statusCounts[0].count} supported`,
            icon: FileText,
            view: 'claims' as const,
          },
          {
            title: 'Evidence records',
            value: evidence.length,
            detail: `${approved} reviewed & approved`,
            icon: CheckCheck,
            view: 'claims' as const,
          },
          {
            title: 'Comparisons',
            value: dashboard.comparisons.length,
            detail: 'Across cases & definitions',
            icon: GitCompareArrows,
            view: 'comparisons' as const,
          },
        ].map(({ title, value, detail, icon: Icon, view }) => (
          <button
            className="stat-card"
            key={title}
            onClick={() => navigate(view)}
          >
            <div className="stat-heading">
              <span>{title}</span>
              <Icon size={18} />
            </div>
            <strong>{value.toString().padStart(2, '0')}</strong>
            <span className="stat-detail">
              {detail}
              <ArrowRight size={14} />
            </span>
          </button>
        ))}
      </section>

      <div className="overview-columns">
        <section
          className="workspace-panel claims-panel"
          aria-label="Current research record"
        >
          <div className="panel-heading">
            <div>
              <h2>Claims in focus</h2>
              <p>Follow the argument back to its evidence.</p>
            </div>
            <button className="text-action" onClick={() => navigate('claims')}>
              View all <ArrowRight size={15} />
            </button>
          </div>
          {dashboard.claims.length ? (
            dashboard.claims.slice(0, 3).map((claim) => (
              <button
                className="claim-preview"
                key={claim.id}
                onClick={() => navigate('claims')}
              >
                <div className="claim-preview-meta">
                  <span className={`status-pill status-${claim.status}`}>
                    {statusLabel(claim.status)}
                  </span>
                  <span>{claim.case_name || 'Unassigned case'}</span>
                </div>
                <h3>{claim.claim_text}</h3>
                <p>{claim.known_limitation}</p>
                <div className="claim-preview-footer">
                  <span>
                    <BookOpen size={14} />{' '}
                    {new Set(claim.evidence.map((item) => item.source_id)).size}{' '}
                    sources
                  </span>
                  <span>
                    <CheckCheck size={14} />{' '}
                    {
                      claim.evidence.filter(
                        (item) => item.review_state === 'approved',
                      ).length
                    }{' '}
                    approved records
                  </span>
                  <ArrowRight size={17} />
                </div>
              </button>
            ))
          ) : (
            <div className="panel-empty">
              <FileText size={28} />
              <h3>Your first argument starts here</h3>
              <p>
                Add a source, then capture a claim and the evidence behind it.
              </p>
              <button
                className="text-action"
                onClick={() => navigate('claims')}
              >
                Open claims <ArrowRight size={15} />
              </button>
            </div>
          )}
        </section>

        <div className="overview-right">
          <section className="workspace-panel confidence-panel">
            <div className="panel-heading">
              <h2>Evidence health</h2>
              <ShieldCheck size={19} />
            </div>
            <div className="health-total">
              <strong>
                {dashboard.claims.length
                  ? Math.round(
                      (dashboard.claims.filter((claim) =>
                        claim.evidence.some(
                          (item) => item.review_state === 'approved',
                        ),
                      ).length /
                        dashboard.claims.length) *
                        100,
                    )
                  : 0}
                <span>%</span>
              </strong>
              <span>
                claims with
                <br />
                approved evidence
              </span>
            </div>
            <div className="status-distribution" aria-hidden="true">
              {statusCounts.map(({ status, count }) => (
                <span
                  key={status}
                  className={`distribution-${status}`}
                  style={{ flex: count || 0.0001 }}
                />
              ))}
            </div>
            <div className="status-legend">
              {statusCounts.map(({ status, count }) => (
                <span key={status}>
                  <i className={`distribution-${status}`} />
                  {statusLabel(status)}
                  <b>{count}</b>
                </span>
              ))}
            </div>
            <div className="health-check">
              <Check size={15} />
              <span>
                {verified} of {dashboard.sources.length} source records verified
              </span>
            </div>
          </section>
          <section className="export-summary">
            <div className="export-icon">
              <ArrowDownToLine size={21} />
            </div>
            <h2>
              {dashboard.export_ready
                ? 'Ready for your next draft.'
                : 'Build a traceable research bundle.'}
            </h2>
            <p>
              {dashboard.export_ready
                ? 'Your reviewed evidence, citations, and comparisons. Together in one export.'
                : 'Review the outstanding checks before exporting your research.'}
            </p>
            <button onClick={() => navigate('export')}>
              {dashboard.export_ready
                ? 'Prepare export'
                : 'Review requirements'}
              <ArrowRight size={16} />
            </button>
          </section>
        </div>
      </div>

      <section className="workspace-panel activity-panel">
        <div className="panel-heading">
          <div>
            <h2>Research activity</h2>
            <p>The decisions behind the work.</p>
          </div>
          <button className="text-action" onClick={() => navigate('decisions')}>
            Decision log <ArrowRight size={15} />
          </button>
        </div>
        {recent.length ? (
          recent.map((decision) => (
            <div className="activity-row" key={decision.id}>
              <div className="activity-icon">
                <FileText size={17} />
              </div>
              <div>
                <span className="activity-type">
                  {statusLabel(decision.entity_type)} updated
                </span>
                <p>{decision.rationale}</p>
              </div>
              <time dateTime={decision.created_at}>
                {new Date(decision.created_at).toLocaleDateString('en', {
                  month: 'short',
                  day: 'numeric',
                  timeZone: 'UTC',
                })}
              </time>
            </div>
          ))
        ) : (
          <div className="panel-empty compact">
            <p>Your research decisions will appear here as you work.</p>
          </div>
        )}
      </section>
    </div>
  );
}
