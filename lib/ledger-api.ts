import type { Dashboard } from '@/lib/ledger-types';

export class ApiError extends Error {
  issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(message);
    this.name = 'ApiError';
    this.issues = issues;
  }
}

type ErrorPayload = {
  detail?: unknown;
  issues?: unknown;
};

function parseErrorPayload(value: unknown, fallback: string): ApiError {
  const body =
    value && typeof value === 'object' ? (value as ErrorPayload) : {};
  const detail =
    typeof body.detail === 'string'
      ? body.detail
      : body.detail
        ? JSON.stringify(body.detail)
        : fallback;
  const issues = Array.isArray(body.issues)
    ? body.issues.filter((issue): issue is string => typeof issue === 'string')
    : [];
  return new ApiError(detail, issues);
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (!(init?.body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
  }
  const response = await fetch(`/api${path}`, {
    ...init,
    headers,
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw parseErrorPayload(body, response.statusText || 'Request failed');
  }
  return response.json() as Promise<T>;
}

export function loadDashboard(): Promise<Dashboard> {
  return request<Dashboard>('/dashboard');
}

export function createSource(payload: Record<string, unknown>) {
  return request('/sources', { method: 'POST', body: JSON.stringify(payload) });
}

export function uploadSource(payload: FormData) {
  return request('/sources/upload', { method: 'POST', body: payload });
}

export function verifySource(sourceId: string) {
  return request(`/sources/${sourceId}/verify`, { method: 'PATCH' });
}

export function createClaim(payload: Record<string, unknown>) {
  return request('/claims', { method: 'POST', body: JSON.stringify(payload) });
}

export function createEvidence(payload: Record<string, unknown>) {
  return request('/evidence', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function approveEvidence(
  evidenceId: string,
  payload?: Record<string, unknown>,
) {
  return request(`/evidence/${evidenceId}/approve`, {
    method: 'PATCH',
    body: payload ? JSON.stringify(payload) : undefined,
  });
}

export function createDefinition(payload: Record<string, unknown>) {
  return request('/definitions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createComparison(payload: Record<string, unknown>) {
  return request('/comparisons', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function createDecision(payload: Record<string, unknown>) {
  return request('/decisions', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export async function downloadExport(): Promise<void> {
  const response = await fetch('/api/export', { method: 'POST' });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    throw parseErrorPayload(body, 'Export blocked');
  }
  const blob = await response.blob();
  const disposition = response.headers.get('content-disposition') ?? '';
  const filename =
    disposition.match(/filename="([^"]+)"/)?.[1] ??
    'policy-evidence-ledger.zip';
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}
