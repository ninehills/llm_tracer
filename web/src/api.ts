import type {
  AtifTrajectory,
  AuthStatus,
  RawRequestDetail,
  TraceListParams,
  TraceListResponse,
  TraceTrajectoriesResponse,
} from './types';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    credentials: 'same-origin',
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const data = (await res.json()) as { error?: string; message?: string };
      if (data.error) msg = data.error;
      else if (data.message) msg = data.message;
    } catch {
      const text = await res.text().catch(() => '');
      if (text) msg = text;
    }
    throw new ApiError(res.status, msg);
  }
  return (await res.json()) as T;
}

export function getAuthStatus(): Promise<AuthStatus> {
  return requestJson<AuthStatus>('/api/auth/status');
}

export function login(key: string): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ key }),
  });
}

export function logout(): Promise<{ ok: boolean }> {
  return requestJson<{ ok: boolean }>('/api/auth/logout', {
    method: 'POST',
  });
}

export function listTraces(params: TraceListParams = {}): Promise<TraceListResponse> {
  const search = new URLSearchParams();
  if (params.q) search.set('q', params.q);
  if (params.harness) search.set('harness', params.harness);
  if (params.upstream) search.set('upstream', params.upstream);
  if (params.limit !== undefined) search.set('limit', String(params.limit));
  if (params.offset !== undefined) search.set('offset', String(params.offset));
  const qs = search.toString();
  return requestJson<TraceListResponse>(qs ? `/api/traces?${qs}` : '/api/traces');
}

export function getTrace<T = unknown>(sessionId: string): Promise<T> {
  return requestJson<T>(`/api/traces/${encodeURIComponent(sessionId)}`);
}

export function fetchRawRequest(id: number): Promise<RawRequestDetail> {
  return requestJson<RawRequestDetail>(`/api/requests/${encodeURIComponent(String(id))}`);
}

export async function fetchTraceTrajectories(sessionId: string): Promise<TraceTrajectoriesResponse> {
  try {
    const res = await requestJson<TraceTrajectoriesResponse>(
      `/api/traces/${encodeURIComponent(sessionId)}/trajectories`
    );
    if (res && Array.isArray(res.trajectories) && res.trajectories.length > 0) {
      return {
        session_id: res.session_id || sessionId,
        upstream_url: res.upstream_url,
        llm_call_count: res.llm_call_count,
        trajectories: res.trajectories,
      };
    }
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) {
      throw err;
    }
  }
  const traj = await getTrace<AtifTrajectory>(sessionId);
  return {
    session_id: traj.session_id || sessionId,
    trajectories: [traj],
  };
}

export async function exportTraces(sessionIds: string[], filename = 'traces.jsonl'): Promise<void> {
  const res = await fetch('/api/traces/export', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ session_ids: sessionIds }),
  });
  if (!res.ok) {
    throw new ApiError(res.status, `Export failed (HTTP ${res.status})`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
