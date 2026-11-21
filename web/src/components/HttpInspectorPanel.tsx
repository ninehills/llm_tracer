import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Copy, Globe, KeyRound, Network, RefreshCw, Search } from 'lucide-react';
import { ApiError, fetchRawRequest } from '../api';
import type { RawRequestDetail } from '../types';
import { formatNumber } from '../utils/format';
import { useI18n } from '../utils/i18n';

interface HttpInspectorPanelProps {
  requestId: number;
  cache: Map<number, RawRequestDetail>;
  onUnauthorized?: () => void;
}

type HttpSection = 'request' | 'response' | 'headers';
type SseViewMode = 'merged' | 'chunks' | 'raw';

function formatBodyPretty(raw: string): { text: string; isJson: boolean } {
  const trimmed = raw.trim();
  if (!trimmed) return { text: '', isJson: false };
  try {
    const parsed = JSON.parse(trimmed);
    return { text: JSON.stringify(parsed, null, 2), isJson: true };
  } catch {
    return { text: raw, isJson: false };
  }
}

function statusBadgeStyle(code: number): string {
  if (code >= 200 && code < 300) {
    return 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-300';
  }
  if (code >= 400 && code < 500) {
    return 'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/15 dark:text-amber-300';
  }
  if (code >= 500) {
    return 'border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/15 dark:text-rose-300';
  }
  return 'border-slate-200 bg-slate-100 text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300';
}

function InlineCopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={handleCopy}
      className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-2 py-1 text-[11px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
    >
      {copied ? (
        <Check className="h-3 w-3 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="h-3 w-3" />
      )}
      {copied ? t('detail.copied') : label || t('detail.copy')}
    </button>
  );
}

function HeadersTable({
  title,
  headers,
}: {
  title: string;
  headers: Record<string, string[]> | undefined;
}) {
  const { t } = useI18n();
  const entries = useMemo(() => {
    if (!headers) return [];
    return Object.entries(headers).sort(([a], [b]) => a.localeCompare(b));
  }, [headers]);

  const jsonText = useMemo(() => JSON.stringify(headers ?? {}, null, 2), [headers]);

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 overflow-hidden bg-white dark:bg-slate-950/60">
      <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 px-3 py-2 text-xs">
        <span className="font-medium text-slate-700 dark:text-slate-300">{title}</span>
        {entries.length > 0 && <InlineCopyButton text={jsonText} label={t('detail.copyJson')} />}
      </div>
      {entries.length === 0 ? (
        <div className="p-4 text-center text-xs text-slate-500">{t('http.noHeaders')}</div>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50/70 dark:bg-slate-950 text-slate-500 dark:text-slate-400">
            <tr>
              <th className="px-3 py-1.5 font-medium">{t('http.colHeader')}</th>
              <th className="px-3 py-1.5 font-medium">{t('http.colValue')}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70 font-mono">
            {entries.map(([key, vals]) => (
              <tr key={key}>
                <td className="px-3 py-1.5 text-slate-600 dark:text-slate-400 whitespace-nowrap align-top">
                  {key}
                </td>
                <td className="px-3 py-1.5 text-slate-800 dark:text-slate-200 break-all">
                  {Array.isArray(vals) ? vals.join(', ') : String(vals ?? '')}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export function HttpInspectorPanel({
  requestId,
  cache,
  onUnauthorized,
}: HttpInspectorPanelProps) {
  const { t } = useI18n();
  const [detail, setDetail] = useState<RawRequestDetail | null>(() => cache.get(requestId) ?? null);
  const [loading, setLoading] = useState<boolean>(() => !cache.has(requestId));
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<HttpSection>('response');
  const [sseMode, setSseMode] = useState<SseViewMode>('merged');
  const [chunkFilter, setChunkFilter] = useState('');

  const loadRequest = useCallback(
    async (force = false) => {
      if (!force && cache.has(requestId)) {
        setDetail(cache.get(requestId)!);
        setLoading(false);
        setError(null);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const res = await fetchRawRequest(requestId);
        cache.set(requestId, res);
        setDetail(res);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.();
          return;
        }
        setError(err instanceof Error ? err.message : t('http.loadError'));
      } finally {
        setLoading(false);
      }
    },
    [requestId, cache, onUnauthorized, t]
  );

  useEffect(() => {
    setChunkFilter('');
    const cached = cache.get(requestId);
    if (cached) {
      setDetail(cached);
      setLoading(false);
      setError(null);
      setSseMode(cached.merged_response ? 'merged' : 'chunks');
      return;
    }
    setDetail(null);
    loadRequest(false);
  }, [requestId, cache, loadRequest]);

  useEffect(() => {
    if (detail?.is_sse) {
      setSseMode(detail.merged_response ? 'merged' : 'chunks');
    }
  }, [detail]);

  const formattedRequestBody = useMemo(
    () => formatBodyPretty(detail?.request_body ?? ''),
    [detail?.request_body]
  );

  const formattedResponseBody = useMemo(
    () => formatBodyPretty(detail?.response_body ?? ''),
    [detail?.response_body]
  );

  const formattedMergedResponse = useMemo(() => {
    if (!detail || detail.merged_response === undefined || detail.merged_response === null) {
      return '';
    }
    return JSON.stringify(detail.merged_response, null, 2);
  }, [detail]);

  const sseEvents = useMemo(() => detail?.sse_events ?? [], [detail?.sse_events]);

  const filteredSseEvents = useMemo(() => {
    const q = chunkFilter.trim().toLowerCase();
    if (!q) return sseEvents;
    return sseEvents.filter(
      (ev) =>
        ev.data.toLowerCase().includes(q) ||
        ev.event.toLowerCase().includes(q) ||
        `#${ev.index}`.includes(q)
    );
  }, [sseEvents, chunkFilter]);

  if (loading) {
    return (
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-8 text-center text-xs text-slate-500 dark:text-slate-400">
        {t('http.loading', { id: requestId })}
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div className="rounded-lg border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 p-4 text-xs text-rose-700 dark:text-rose-300 flex items-center justify-between gap-3">
        <span>{error || t('http.loadError')}</span>
        <button
          type="button"
          onClick={() => loadRequest(true)}
          className="inline-flex items-center gap-1 rounded-md border border-rose-300 dark:border-rose-500/40 bg-white dark:bg-slate-900 px-2.5 py-1 text-xs font-medium text-rose-700 dark:text-rose-300 hover:bg-rose-50 dark:hover:bg-rose-950/40 cursor-pointer"
        >
          <RefreshCw className="h-3 w-3" />
          {t('http.retry')}
        </button>
      </div>
    );
  }

  const fullPath = detail.query ? `${detail.path}?${detail.query}` : detail.path;
  const reqHeaderCount = Object.keys(detail.request_headers ?? {}).length;
  const resHeaderCount = Object.keys(detail.response_headers ?? {}).length;

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 p-3 space-y-2">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-indigo-700 dark:text-indigo-300">
            <Globe className="h-3 w-3" />
            {detail.method}
          </span>
          <span className="font-mono text-xs font-medium text-slate-900 dark:text-slate-100 break-all">
            {fullPath}
          </span>
          <span
            className={`inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[11px] font-semibold ${statusBadgeStyle(
              detail.status_code
            )}`}
          >
            {detail.status_code}
          </span>
          <span className="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-1.5 py-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300">
            {formatNumber(detail.latency_ms)} ms
          </span>
          <span
            className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium ${
              detail.is_sse
                ? 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/15 dark:text-cyan-300'
                : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'
            }`}
          >
            {detail.is_sse ? t('detail.metaStreamSse') : t('detail.metaNonStream')}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-400">
          {detail.upstream && (
            <span>
              <span className="text-slate-500">{t('detail.metaUpstream')}:</span>{' '}
              <span className="font-mono text-slate-800 dark:text-slate-200">{detail.upstream}</span>
            </span>
          )}
          {detail.response_model && (
            <span>
              <span className="text-slate-500">{t('detail.metaResponseModel')}:</span>{' '}
              <span className="rounded border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 px-1.5 py-0.5 font-mono text-emerald-700 dark:text-emerald-300">
                {detail.response_model}
              </span>
            </span>
          )}
          {detail.response_id && (
            <span>
              <span className="text-slate-500">{t('detail.metaResponseId')}:</span>{' '}
              <span className="font-mono text-slate-800 dark:text-slate-200">{detail.response_id}</span>
            </span>
          )}
          {detail.finish_reason && (
            <span>
              <span className="text-slate-500">{t('detail.metaFinishReason')}:</span>{' '}
              <span className="rounded border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/15 px-1.5 py-0.5 font-mono text-violet-700 dark:text-violet-300">
                {detail.finish_reason}
              </span>
            </span>
          )}
          {detail.client_ip && (
            <span className="inline-flex items-center gap-1">
              <Network className="h-3 w-3 text-slate-400 dark:text-slate-500" />
              <span className="text-slate-500">{t('detail.metaClientIp')}:</span>{' '}
              <span className="font-mono text-slate-800 dark:text-slate-200">{detail.client_ip}</span>
            </span>
          )}
        </div>

        {detail.api_key_hash && (
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/80 dark:border-slate-800/80 pt-2 text-[11px]">
            <div className="flex items-start gap-1.5 min-w-0 flex-1">
              <KeyRound className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
              <span className="shrink-0 text-slate-500">{t('detail.metaApiKeyHash')}:</span>
              <span className="font-mono text-slate-800 dark:text-slate-200 break-all">
                {detail.api_key_hash}
              </span>
            </div>
            <InlineCopyButton text={detail.api_key_hash} />
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 p-0.5 text-xs">
          {(
            [
              ['request', t('http.tabRequest')],
              ['response', t('http.tabResponse')],
              ['headers', `${t('http.tabHeaders')} (${reqHeaderCount + resHeaderCount})`],
            ] as Array<[HttpSection, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setSection(key)}
              className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                section === key
                  ? 'bg-indigo-600 text-white'
                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {section === 'response' && detail.is_sse && (
          <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 p-0.5 text-[11px]">
            {(
              [
                ['merged', t('http.sseMerged')],
                ['chunks', t('http.sseChunks', { count: sseEvents.length })],
                ['raw', t('http.sseRaw')],
              ] as Array<[SseViewMode, string]>
            ).map(([mode, label]) => (
              <button
                key={mode}
                type="button"
                onClick={() => setSseMode(mode)}
                className={`rounded-md px-2 py-1 font-medium transition-colors cursor-pointer ${
                  sseMode === mode
                    ? 'bg-cyan-600 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>

      {section === 'request' && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {t('http.requestBody')}
            </span>
            {detail.request_body && (
              <InlineCopyButton
                text={formattedRequestBody.text}
                label={formattedRequestBody.isJson ? t('detail.copyJson') : t('detail.copy')}
              />
            )}
          </div>
          {formattedRequestBody.text ? (
            <pre className="max-h-[48vh] overflow-auto p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words">
              {formattedRequestBody.text}
            </pre>
          ) : (
            <div className="p-6 text-center text-xs text-slate-500">{t('http.emptyBody')}</div>
          )}
        </div>
      )}

      {section === 'response' && !detail.is_sse && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {t('http.responseBody')}
            </span>
            {detail.response_body && (
              <InlineCopyButton
                text={formattedResponseBody.text}
                label={formattedResponseBody.isJson ? t('detail.copyJson') : t('detail.copy')}
              />
            )}
          </div>
          {formattedResponseBody.text ? (
            <pre className="max-h-[48vh] overflow-auto p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words">
              {formattedResponseBody.text}
            </pre>
          ) : (
            <div className="p-6 text-center text-xs text-slate-500">{t('http.emptyBody')}</div>
          )}
        </div>
      )}

      {section === 'response' && detail.is_sse && sseMode === 'merged' && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {t('http.sseMerged')}
            </span>
            {formattedMergedResponse && (
              <InlineCopyButton text={formattedMergedResponse} label={t('detail.copyJson')} />
            )}
          </div>
          {formattedMergedResponse ? (
            <pre className="max-h-[48vh] overflow-auto p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words">
              {formattedMergedResponse}
            </pre>
          ) : (
            <div className="p-6 text-center text-xs text-slate-500">
              {t('http.noMergedResponse')}
            </div>
          )}
        </div>
      )}

      {section === 'response' && detail.is_sse && sseMode === 'chunks' && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950/60 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/80 px-3 py-2">
            <div className="relative min-w-[180px] flex-1 max-w-xs">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
              <input
                type="text"
                value={chunkFilter}
                onChange={(e) => setChunkFilter(e.target.value)}
                placeholder={t('http.filterChunksPlaceholder')}
                className="w-full rounded-md border border-slate-300 dark:border-slate-700/80 bg-white dark:bg-slate-950 py-1 pl-8 pr-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
              />
            </div>
            <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400">
              {t('http.chunkCount', { shown: filteredSseEvents.length, total: sseEvents.length })}
            </span>
          </div>

          {filteredSseEvents.length === 0 ? (
            <div className="p-6 text-center text-xs text-slate-500">{t('http.noSseEvents')}</div>
          ) : (
            <div className="max-h-[48vh] overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800/70">
              {filteredSseEvents.map((ev) => {
                const formatted = formatBodyPretty(ev.data);
                return (
                  <div key={ev.index} className="p-2.5 space-y-1.5">
                    <div className="flex items-center justify-between gap-2 text-[11px]">
                      <div className="flex items-center gap-1.5">
                        <span className="rounded border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-1.5 py-0.5 font-mono font-medium text-slate-600 dark:text-slate-400">
                          #{ev.index}
                        </span>
                        {ev.event && (
                          <span className="rounded border border-cyan-200 dark:border-cyan-500/30 bg-cyan-50 dark:bg-cyan-500/15 px-1.5 py-0.5 font-mono text-cyan-700 dark:text-cyan-300">
                            {ev.event}
                          </span>
                        )}
                      </div>
                      <InlineCopyButton text={formatted.text || ev.data} />
                    </div>
                    <pre className="max-h-44 overflow-auto rounded border border-slate-200 dark:border-slate-800/80 bg-slate-50 dark:bg-slate-950 p-2 font-mono text-[11px] leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words">
                      {formatted.text || ev.data}
                    </pre>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {section === 'response' && detail.is_sse && sseMode === 'raw' && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 overflow-hidden">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="font-medium text-slate-700 dark:text-slate-300">
              {t('http.sseRaw')}
            </span>
            {detail.response_body && (
              <InlineCopyButton text={detail.response_body} label={t('http.copyRaw')} />
            )}
          </div>
          {detail.response_body ? (
            <pre className="max-h-[48vh] overflow-auto p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200 whitespace-pre-wrap break-words">
              {detail.response_body}
            </pre>
          ) : (
            <div className="p-6 text-center text-xs text-slate-500">{t('http.emptyBody')}</div>
          )}
        </div>
      )}

      {section === 'headers' && (
        <div className="space-y-3">
          <HeadersTable
            title={t('http.requestHeaders', { count: reqHeaderCount })}
            headers={detail.request_headers}
          />
          <HeadersTable
            title={t('http.responseHeaders', { count: resHeaderCount })}
            headers={detail.response_headers}
          />
        </div>
      )}
    </div>
  );
}
