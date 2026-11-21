import { useMemo } from 'react';
import {
  Search,
  Download,
  RefreshCw,
  FolderOpen,
  Cpu,
  Layers,
  Clock,
  ChevronLeft,
  ChevronRight,
  CheckSquare,
  Square,
  MinusSquare,
  ExternalLink,
  KeyRound,
  Network,
  Sparkles,
} from 'lucide-react';
import type { TraceSummary } from '../types';
import {
  formatCacheHitRate,
  formatNumber,
  formatTokensCompact,
  formatTimestamp,
  harnessBadgeColor,
  shortApiKeyHash,
} from '../utils/format';
import { useI18n } from '../utils/i18n';

interface TraceListProps {
  traces: TraceSummary[];
  total: number;
  loading: boolean;
  error: string | null;
  query: string;
  harnessFilter: string;
  upstreamFilter: string;
  limit: number;
  offset: number;
  selectedIds: Set<string>;
  exporting: boolean;
  onQueryChange: (q: string) => void;
  onHarnessChange: (h: string) => void;
  onUpstreamChange: (u: string) => void;
  onPageChange: (nextOffset: number) => void;
  onRefresh: () => void;
  onToggleSelect: (sessionId: string) => void;
  onToggleSelectAll: () => void;
  onExportSelected: () => void;
  onExportSingle: (sessionId: string) => void;
  onOpenTrace: (sessionId: string) => void;
}

export function TraceList({
  traces,
  total,
  loading,
  error,
  query,
  harnessFilter,
  upstreamFilter,
  limit,
  offset,
  selectedIds,
  exporting,
  onQueryChange,
  onHarnessChange,
  onUpstreamChange,
  onPageChange,
  onRefresh,
  onToggleSelect,
  onToggleSelectAll,
  onExportSelected,
  onExportSingle,
  onOpenTrace,
}: TraceListProps) {
  const { lang, t } = useI18n();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';

  const harnesses = useMemo(() => {
    const s = new Set<string>();
    traces.forEach((tr) => {
      if (tr.harness) s.add(tr.harness);
    });
    if (harnessFilter) s.add(harnessFilter);
    return Array.from(s).sort();
  }, [traces, harnessFilter]);

  const upstreams = useMemo(() => {
    const s = new Set<string>();
    traces.forEach((tr) => {
      if (tr.upstream) s.add(tr.upstream);
    });
    if (upstreamFilter) s.add(upstreamFilter);
    return Array.from(s).sort();
  }, [traces, upstreamFilter]);

  const allVisibleSelected =
    traces.length > 0 && traces.every((tr) => selectedIds.has(tr.session_id));
  const someVisibleSelected =
    traces.some((tr) => selectedIds.has(tr.session_id)) && !allVisibleSelected;

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = Math.min(offset + traces.length, total);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-3.5 shadow-xs dark:shadow-none">
        <div className="flex flex-1 flex-wrap items-center gap-2.5">
          <div className="relative flex-1 min-w-[220px] max-w-md">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              value={query}
              onChange={(e) => onQueryChange(e.target.value)}
              placeholder={t('list.searchPlaceholder')}
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700/80 bg-white dark:bg-slate-950 py-2 pl-9 pr-3 text-sm text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
            />
          </div>

          <select
            value={harnessFilter}
            onChange={(e) => onHarnessChange(e.target.value)}
            aria-label={t('list.filterHarnessAria')}
            className="rounded-lg border border-slate-300 dark:border-slate-700/80 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="">{t('list.allHarnesses')}</option>
            {harnesses.map((h) => (
              <option key={h} value={h}>
                {h}
              </option>
            ))}
          </select>

          <select
            value={upstreamFilter}
            onChange={(e) => onUpstreamChange(e.target.value)}
            aria-label={t('list.filterUpstreamAria')}
            className="rounded-lg border border-slate-300 dark:border-slate-700/80 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-700 dark:text-slate-200 focus:border-indigo-500 focus:outline-none"
          >
            <option value="">{t('list.allUpstreams')}</option>
            {upstreams.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700/80 disabled:opacity-50 transition-colors cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            {t('list.refresh')}
          </button>

          <button
            type="button"
            onClick={onExportSelected}
            disabled={selectedIds.size === 0 || exporting}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3.5 py-2 text-xs font-medium text-white hover:bg-indigo-500 disabled:bg-slate-200 dark:disabled:bg-slate-800 disabled:text-slate-400 dark:disabled:text-slate-500 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            {t('list.exportJsonl')}
            {selectedIds.size > 0 ? ` (${selectedIds.size})` : ''}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 p-4 text-sm text-rose-700 dark:text-rose-300">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 shadow-xs dark:shadow-none">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/90 text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400">
                <th className="w-10 px-4 py-3">
                  <button
                    type="button"
                    onClick={onToggleSelectAll}
                    aria-label={t('list.selectAllAria')}
                    className="flex items-center justify-center text-slate-400 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer"
                  >
                    {allVisibleSelected ? (
                      <CheckSquare className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                    ) : someVisibleSelected ? (
                      <MinusSquare className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                    ) : (
                      <Square className="h-4 w-4" />
                    )}
                  </button>
                </th>
                <th className="px-4 py-3 font-medium">{t('list.colSession')}</th>
                <th className="px-4 py-3 font-medium">{t('list.colHarness')}</th>
                <th className="px-4 py-3 font-medium">{t('list.colUpstreamModel')}</th>
                <th className="px-4 py-3 font-medium">{t('list.colClientKey')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('list.colSteps')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('list.colTokens')}</th>
                <th className="px-4 py-3 font-medium text-right">{t('list.colUpdated')}</th>
                <th className="w-24 px-4 py-3 font-medium text-right">{t('list.colActions')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70">
              {loading && traces.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-12 text-center text-slate-500 dark:text-slate-400">
                    {t('list.loading')}
                  </td>
                </tr>
              ) : traces.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-14 text-center">
                    <div className="text-slate-700 dark:text-slate-300 font-medium mb-1">
                      {t('list.emptyTitle')}
                    </div>
                    <div className="text-xs text-slate-500">
                      {t('list.emptyHintPrefix')}{' '}
                      <code className="font-mono text-slate-700 dark:text-slate-400">
                        /proxy/&lt;upstream&gt;/...
                      </code>{' '}
                      {t('list.emptyHintSuffix')}
                    </div>
                  </td>
                </tr>
              ) : (
                traces.map((trace) => {
                  const selected = selectedIds.has(trace.session_id);
                  return (
                    <tr
                      key={trace.session_id}
                      onClick={() => onOpenTrace(trace.session_id)}
                      className={`group cursor-pointer transition-colors ${
                        selected
                          ? 'bg-indigo-50/80 hover:bg-indigo-50 dark:bg-indigo-500/10 dark:hover:bg-indigo-500/15'
                          : 'hover:bg-slate-50 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <td
                        className="px-4 py-3.5"
                        onClick={(e) => {
                          e.stopPropagation();
                          onToggleSelect(trace.session_id);
                        }}
                      >
                        <button
                          type="button"
                          aria-label={t('list.selectTraceAria', { id: trace.session_id })}
                          className="flex items-center justify-center text-slate-400 dark:text-slate-500 hover:text-indigo-600 dark:hover:text-indigo-400 cursor-pointer"
                        >
                          {selected ? (
                            <CheckSquare className="h-4 w-4 text-indigo-600 dark:text-indigo-400" />
                          ) : (
                            <Square className="h-4 w-4" />
                          )}
                        </button>
                      </td>

                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-xs font-medium text-indigo-600 group-hover:text-indigo-700 dark:text-indigo-300 dark:group-hover:text-indigo-200">
                            {trace.session_id}
                          </span>
                          {trace.trajectory_count !== undefined && trace.trajectory_count > 1 && (
                            <span
                              title={t('list.segmentsTitle', { count: trace.trajectory_count })}
                              className="inline-flex items-center rounded-md border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300 whitespace-nowrap"
                            >
                              {t('list.segmentsBadge', { count: trace.trajectory_count })}
                            </span>
                          )}
                        </div>
                        {trace.work_dir && (
                          <div
                            className="mt-1 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400 max-w-sm truncate"
                            title={trace.work_dir}
                          >
                            <FolderOpen className="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500" />
                            <span className="truncate font-mono">{trace.work_dir}</span>
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3.5">
                        <span
                          className={`inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium ${harnessBadgeColor(
                            trace.harness
                          )}`}
                        >
                          {trace.harness || t('list.unknown')}
                        </span>
                      </td>

                      <td className="px-4 py-3.5">
                        <div className="flex items-center gap-1.5 text-xs text-slate-800 dark:text-slate-200">
                          <Cpu className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500 shrink-0" />
                          <span className="font-mono truncate max-w-[200px]" title={trace.model}>
                            {trace.model || '—'}
                          </span>
                        </div>
                        <div className="mt-0.5 text-[11px] text-slate-500 font-mono">
                          {trace.upstream || '—'}
                        </div>
                      </td>

                      <td className="px-4 py-3.5 whitespace-nowrap">
                        {trace.client_ip || trace.api_key_hash ? (
                          <div className="space-y-1">
                            {trace.client_ip && (
                              <div className="inline-flex items-center gap-1 font-mono text-xs text-slate-700 dark:text-slate-300">
                                <Network className="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500" />
                                <span>{trace.client_ip}</span>
                              </div>
                            )}
                            {trace.api_key_hash && (
                              <div>
                                <span
                                  title={`${t('detail.metaApiKeyHash')}: ${trace.api_key_hash}`}
                                  className="inline-flex items-center gap-1 rounded border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-amber-800 dark:text-amber-300"
                                >
                                  <KeyRound className="h-2.5 w-2.5 shrink-0 text-amber-600 dark:text-amber-400" />
                                  {shortApiKeyHash(trace.api_key_hash)}
                                </span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <span className="font-mono text-xs text-slate-400 dark:text-slate-600">—</span>
                        )}
                      </td>

                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        {(() => {
                          const llmCalls = trace.llm_call_count ?? trace.request_count;
                          return (
                            <>
                              <div className="flex items-center justify-end gap-1 text-xs font-medium text-violet-700 dark:text-violet-300">
                                <Sparkles className="h-3.5 w-3.5 text-violet-500 dark:text-violet-400" />
                                <span className="font-mono">{formatNumber(llmCalls)}</span>
                                <span>
                                  {llmCalls === 1 ? t('list.llmCallSingular') : t('list.llmCallPlural')}
                                </span>
                              </div>
                              <div className="mt-0.5 flex items-center justify-end gap-1 text-[11px] text-slate-500 dark:text-slate-400">
                                <Layers className="h-3 w-3 text-slate-400 dark:text-slate-500" />
                                <span className="font-mono">{formatNumber(trace.step_count)}</span>
                                <span>
                                  {trace.step_count === 1 ? t('detail.stepSingular') : t('detail.stepPlural')}
                                </span>
                              </div>
                            </>
                          );
                        })()}
                      </td>

                      <td className="px-4 py-3.5 text-right whitespace-nowrap font-mono text-xs">
                        <div className="text-slate-800 dark:text-slate-200">
                          <span title={t('list.promptTokens')}>
                            {formatTokensCompact(trace.total_prompt_tokens)}
                          </span>
                          <span className="text-slate-400 dark:text-slate-600"> / </span>
                          <span
                            className="text-emerald-600 dark:text-emerald-400"
                            title={t('list.completionTokens')}
                          >
                            {formatTokensCompact(trace.total_completion_tokens)}
                          </span>
                          <span className="text-slate-400 dark:text-slate-600"> / </span>
                          <span
                            className="text-sky-600 dark:text-sky-400"
                            title={`${t('list.cachedTokens')}: ${formatNumber(trace.total_cached_tokens ?? 0)}`}
                          >
                            {formatTokensCompact(trace.total_cached_tokens ?? 0)}
                          </span>
                        </div>
                        <div
                          className="mt-0.5 text-[11px] text-sky-600 dark:text-sky-400"
                          title={`${t('list.cachedTokens')}: ${formatNumber(trace.total_cached_tokens ?? 0)} / ${formatNumber(trace.total_prompt_tokens)}`}
                        >
                          {t('list.cacheHitRate')}{' '}
                          {formatCacheHitRate(trace.total_cached_tokens, trace.total_prompt_tokens)}
                        </div>
                      </td>

                      <td className="px-4 py-3.5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1 text-xs text-slate-600 dark:text-slate-300">
                          <Clock className="h-3 w-3 text-slate-400 dark:text-slate-500" />
                          {formatTimestamp(trace.updated_at || trace.started_at, locale)}
                        </div>
                      </td>

                      <td
                        className="px-4 py-3.5 text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => onExportSingle(trace.session_id)}
                            title={t('list.exportJsonl')}
                            className="rounded-md p-1.5 text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800 hover:text-slate-800 dark:hover:text-slate-200 transition-colors cursor-pointer"
                          >
                            <Download className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => onOpenTrace(trace.session_id)}
                            title={t('list.openDetail')}
                            className="rounded-md p-1.5 text-slate-500 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800 hover:text-indigo-600 dark:hover:text-indigo-300 transition-colors cursor-pointer"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between border-t border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 px-4 py-2.5 text-xs text-slate-500 dark:text-slate-400">
          <div>
            {t('list.showing')}{' '}
            <span className="font-medium text-slate-800 dark:text-slate-200">{pageStart}</span>–
            <span className="font-medium text-slate-800 dark:text-slate-200">{pageEnd}</span>{' '}
            {t('list.of')}{' '}
            <span className="font-medium text-slate-800 dark:text-slate-200">
              {formatNumber(total)}
            </span>{' '}
            {t('list.tracesUnit')}
          </div>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => onPageChange(Math.max(0, offset - limit))}
              disabled={offset === 0}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-2.5 py-1 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              {t('list.prev')}
            </button>
            <button
              type="button"
              onClick={() => onPageChange(offset + limit)}
              disabled={offset + limit >= total}
              className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-2.5 py-1 text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
            >
              {t('list.next')}
              <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
