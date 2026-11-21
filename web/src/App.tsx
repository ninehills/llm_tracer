import { useCallback, useEffect, useState } from 'react';
import { Activity, LogOut, ShieldCheck, ShieldOff } from 'lucide-react';
import {
  ApiError,
  exportTraces,
  getAuthStatus,
  listTraces,
  logout,
} from './api';
import type { AuthStatus, TraceSummary } from './types';
import { LoginView } from './components/LoginView';
import { InsecureBanner } from './components/InsecureBanner';
import { TraceList } from './components/TraceList';
import { TraceDetail } from './components/TraceDetail';
import { HeaderControls } from './components/HeaderControls';
import { useI18n } from './utils/i18n';

const PAGE_LIMIT = 50;

function readSessionFromHash(): string | null {
  const hash = window.location.hash || '';
  const match = hash.match(/^#\/traces\/(.+)$/);
  return match ? decodeURIComponent(match[1]) : null;
}

export function App() {
  const { t } = useI18n();
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState<string | null>(null);

  const [traces, setTraces] = useState<TraceSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [query, setQuery] = useState('');
  const [harnessFilter, setHarnessFilter] = useState('');
  const [upstreamFilter, setUpstreamFilter] = useState('');
  const [offset, setOffset] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const [activeSessionId, setActiveSessionId] = useState<string | null>(() =>
    readSessionFromHash()
  );

  const checkAuth = useCallback(async () => {
    setAuthLoading(true);
    setAuthError(null);
    try {
      const status = await getAuthStatus();
      setAuth(status);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : t('app.connectError'));
    } finally {
      setAuthLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void checkAuth();
  }, [checkAuth]);

  useEffect(() => {
    function onHashChange() {
      setActiveSessionId(readSessionFromHash());
    }
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  const canAccess = Boolean(auth && (!auth.auth_required || auth.authenticated));

  const fetchTraces = useCallback(async () => {
    if (!canAccess) return;
    setListLoading(true);
    setListError(null);
    try {
      const res = await listTraces({
        q: query.trim() || undefined,
        harness: harnessFilter || undefined,
        upstream: upstreamFilter || undefined,
        limit: PAGE_LIMIT,
        offset,
      });
      setTraces(res.traces ?? []);
      setTotal(res.total ?? 0);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void checkAuth();
        return;
      }
      setListError(err instanceof Error ? err.message : t('app.loadTracesError'));
    } finally {
      setListLoading(false);
    }
  }, [canAccess, query, harnessFilter, upstreamFilter, offset, checkAuth, t]);

  useEffect(() => {
    if (!canAccess || activeSessionId) return;
    const timer = setTimeout(() => {
      void fetchTraces();
    }, 150);
    return () => clearTimeout(timer);
  }, [canAccess, activeSessionId, fetchTraces]);

  function openTrace(sessionId: string) {
    window.location.hash = `#/traces/${encodeURIComponent(sessionId)}`;
    setActiveSessionId(sessionId);
  }

  function closeTrace() {
    window.location.hash = '';
    setActiveSessionId(null);
  }

  function handleToggleSelect(sessionId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }

  function handleToggleSelectAll() {
    setSelectedIds((prev) => {
      const allSelected =
        traces.length > 0 && traces.every((tr) => prev.has(tr.session_id));
      const next = new Set(prev);
      if (allSelected) {
        traces.forEach((tr) => next.delete(tr.session_id));
      } else {
        traces.forEach((tr) => next.add(tr.session_id));
      }
      return next;
    });
  }

  async function handleExport(sessionIds: string[]) {
    if (sessionIds.length === 0) return;
    setExporting(true);
    try {
      await exportTraces(sessionIds, 'traces.jsonl');
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        void checkAuth();
        return;
      }
      setListError(err instanceof Error ? err.message : t('app.exportError'));
    } finally {
      setExporting(false);
    }
  }

  async function handleLogout() {
    try {
      await logout();
    } finally {
      setSelectedIds(new Set());
      setTraces([]);
      await checkAuth();
    }
  }

  if (authLoading) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center text-sm text-slate-500 dark:text-slate-400">
        {t('app.connecting')}
      </div>
    );
  }

  if (authError || !auth) {
    return (
      <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex items-center justify-center p-4">
        <div className="max-w-md rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 p-6 text-center space-y-3">
          <div className="text-sm font-medium text-rose-700 dark:text-rose-200">
            {authError || t('app.unreachable')}
          </div>
          <button
            type="button"
            onClick={() => void checkAuth()}
            className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 px-4 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
          >
            {t('app.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (auth.auth_required && !auth.authenticated) {
    return <LoginView onSuccess={() => void checkAuth()} />;
  }

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 text-slate-900 dark:text-slate-100 flex flex-col transition-colors">
      {auth.insecure_no_auth_warning && <InsecureBanner />}

      <header className="border-b border-slate-200 dark:border-slate-800 bg-white/90 dark:bg-slate-900/80 backdrop-blur">
        <div className="mx-auto flex max-w-[1600px] items-center justify-between px-4 sm:px-6 py-3">
          <button
            type="button"
            onClick={closeTrace}
            className="flex items-center gap-2.5 text-left cursor-pointer group"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 dark:bg-indigo-500/15 border border-indigo-200 dark:border-indigo-500/30 text-indigo-600 dark:text-indigo-400 group-hover:bg-indigo-100 dark:group-hover:bg-indigo-500/25 transition-colors">
              <Activity className="h-4 w-4" />
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 leading-tight">
                {t('app.title')}
              </div>
              <div className="text-[11px] text-slate-500 dark:text-slate-400">
                {t('app.subtitle')}
              </div>
            </div>
          </button>

          <div className="flex items-center gap-2.5">
            <span
              className={`hidden sm:inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                auth.auth_required
                  ? 'border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : 'border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/80 text-slate-600 dark:text-slate-400'
              }`}
            >
              {auth.auth_required ? (
                <>
                  <ShieldCheck className="h-3 w-3" />
                  {t('app.authEnabled')}
                </>
              ) : (
                <>
                  <ShieldOff className="h-3 w-3" />
                  {auth.is_localhost ? t('app.localhostNoAuth') : t('app.noAuth')}
                </>
              )}
            </span>

            <HeaderControls />

            {auth.auth_required && auth.authenticated && (
              <button
                type="button"
                onClick={() => void handleLogout()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-3 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                <LogOut className="h-3.5 w-3.5" />
                {t('app.logout')}
              </button>
            )}
          </div>
        </div>
      </header>

      <main className="mx-auto w-full max-w-[1600px] flex-1 px-4 sm:px-6 py-5">
        {activeSessionId ? (
          <TraceDetail
            sessionId={activeSessionId}
            onBack={closeTrace}
            onExport={(sid) => void handleExport([sid])}
            onUnauthorized={checkAuth}
          />
        ) : (
          <TraceList
            traces={traces}
            total={total}
            loading={listLoading}
            error={listError}
            query={query}
            harnessFilter={harnessFilter}
            upstreamFilter={upstreamFilter}
            limit={PAGE_LIMIT}
            offset={offset}
            selectedIds={selectedIds}
            exporting={exporting}
            onQueryChange={(q) => {
              setQuery(q);
              setOffset(0);
            }}
            onHarnessChange={(h) => {
              setHarnessFilter(h);
              setOffset(0);
            }}
            onUpstreamChange={(u) => {
              setUpstreamFilter(u);
              setOffset(0);
            }}
            onPageChange={setOffset}
            onRefresh={() => void fetchTraces()}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            onExportSelected={() => void handleExport(Array.from(selectedIds))}
            onExportSingle={(sid) => void handleExport([sid])}
            onOpenTrace={openTrace}
          />
        )}
      </main>
    </div>
  );
}
