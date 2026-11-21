import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Clock,
  Code2,
  Copy,
  Cpu,
  Database,
  Download,
  FolderOpen,
  GitBranch,
  Globe,
  KeyRound,
  Layers,
  Link2,
  MessageSquare,
  Network,
  Search,
  Server,
  Sparkles,
  Terminal,
  User,
  Wrench,
} from 'lucide-react';
import type { DeepReadonly, TraceSpan, TraceSpanCategory } from '@evilmartians/agent-prism-types';
import {
  filterSpansRecursively,
  findTimeRange,
  flattenSpans,
  formatDuration as formatPrismDuration,
  getDurationMs,
  getTimelineData,
  getTotalTokens,
  hasThinkingContent,
  toPlainAttributeValue,
} from '@evilmartians/agent-prism-data';
import { ApiError, fetchTraceTrajectories } from '../api';
import type { AtifTrajectory, RawRequestDetail } from '../types';
import {
  adaptAtifToAgentPrism,
  summarizeSession,
  summarizeTrajectory,
  type AtifSpanMetadata,
} from '../utils/atifAdapter';
import {
  formatCacheHitRate,
  formatCompactTimestamp,
  formatDuration,
  formatFullTimestamp,
  formatNumber,
  formatTimestamp,
  harnessBadgeColor,
  shortApiKeyHash,
} from '../utils/format';
import { useI18n, type TranslationKey } from '../utils/i18n';
import { HttpInspectorPanel } from './HttpInspectorPanel';

interface TraceDetailProps {
  sessionId: string;
  onBack: () => void;
  onExport: (sessionId: string) => void;
  onUnauthorized?: () => void;
}

type ViewMode = 'prism' | 'tools' | 'raw';
type DetailTab = 'overview' | 'http' | 'tools' | 'attributes' | 'raw';
type CategoryFilter = 'all' | 'llm_call' | 'tool_execution' | 'event';

const LLM_KNOWN_EXTRA_KEYS = new Set([
  'request_record_id',
  'requested_model',
  'response_model',
  'response_id',
  'finish_reason',
  'stop_reason',
  'status_code',
  'latency_ms',
  'is_stream',
  'upstream',
  'http_method',
  'http_path',
  'request_id',
  'source',
  'api_key_hash',
  'client_ip',
]);

const ROOT_KNOWN_EXTRA_KEYS = new Set([
  'work_dir',
  'workdir',
  'cwd',
  'upstream',
  'harness',
  'response_model',
  'api_key_hash',
  'client_ip',
  'llm_call_count',
  'started_at',
  'ended_at',
  'updated_at',
  'duration_ms',
]);

function formatExtraValue(val: unknown): string {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return JSON.stringify(val);
}

function httpStatusPillClass(code: number): string {
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

function categoryStyle(
  type: TraceSpanCategory,
  source: string | undefined,
  t: (key: TranslationKey) => string
) {
  if (type === 'agent_invocation') {
    return {
      badge: 'bg-indigo-50 text-indigo-700 border-indigo-200 dark:bg-indigo-500/15 dark:text-indigo-300 dark:border-indigo-500/30',
      bar: 'bg-indigo-500',
      label: t('detail.catAgent'),
      Icon: GitBranch,
    };
  }
  if (type === 'llm_call') {
    return {
      badge: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30',
      bar: 'bg-violet-500',
      label: t('detail.catLlm'),
      Icon: Sparkles,
    };
  }
  if (type === 'tool_execution') {
    return {
      badge: 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
      bar: 'bg-amber-500',
      label: t('detail.catTool'),
      Icon: Wrench,
    };
  }
  if (type === 'retrieval') {
    return {
      badge: 'bg-cyan-50 text-cyan-700 border-cyan-200 dark:bg-cyan-500/15 dark:text-cyan-300 dark:border-cyan-500/30',
      bar: 'bg-cyan-500',
      label: t('detail.catObs'),
      Icon: Terminal,
    };
  }
  if (source === 'system') {
    return {
      badge: 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-600/30 dark:text-slate-300 dark:border-slate-500/40',
      bar: 'bg-slate-500',
      label: t('detail.catSystem'),
      Icon: Terminal,
    };
  }
  if (source === 'user') {
    return {
      badge: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
      bar: 'bg-emerald-500',
      label: t('detail.catUser'),
      Icon: User,
    };
  }
  return {
    badge: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30',
    bar: 'bg-sky-500',
    label: type,
    Icon: MessageSquare,
  };
}

type SpanNode = DeepReadonly<TraceSpan<AtifSpanMetadata>>;

function SpanTreeRow({
  span,
  depth,
  selectedId,
  collapsed,
  minStart,
  maxEnd,
  onSelect,
  onToggleCollapse,
}: {
  span: SpanNode;
  depth: number;
  selectedId: string | null;
  collapsed: Set<string>;
  minStart: number;
  maxEnd: number;
  onSelect: (span: SpanNode) => void;
  onToggleCollapse: (id: string) => void;
}) {
  const { t } = useI18n();
  const hasChildren = Boolean(span.children && span.children.length > 0);
  const isCollapsed = collapsed.has(span.id);
  const isSelected = selectedId === span.id;
  const sourceStr = typeof span.metadata?.source === 'string' ? span.metadata.source : undefined;
  const style = categoryStyle(span.type, sourceStr, t);
  const Icon = style.Icon;
  const timeline = getTimelineData({ spanCard: span, minStart, maxEnd });
  const durationMs = getDurationMs(span);
  const tokens = getTotalTokens(span.tokenUsage);
  const hasThinking = hasThinkingContent(span);
  const isCopiedContext = span.metadata?.isCopiedContext === true;

  return (
    <>
      <div
        onClick={() => onSelect(span)}
        className={`group flex items-center gap-2 border-b border-slate-200/80 dark:border-slate-800/60 px-3 py-2 text-xs cursor-pointer transition-colors ${
          isSelected
            ? 'bg-indigo-50 text-slate-900 dark:bg-indigo-500/15 dark:text-slate-100'
            : 'hover:bg-slate-100/80 text-slate-700 dark:hover:bg-slate-800/50 dark:text-slate-300'
        }`}
        style={{ paddingLeft: `${depth * 18 + 10}px` }}
      >
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren) onToggleCollapse(span.id);
          }}
          className={`flex h-4 w-4 shrink-0 items-center justify-center text-slate-400 dark:text-slate-500 hover:text-slate-700 dark:hover:text-slate-200 ${
            hasChildren ? 'cursor-pointer' : 'invisible'
          }`}
          aria-label={isCollapsed ? t('detail.expandSpan') : t('detail.collapseSpan')}
        >
          {isCollapsed ? <ChevronRight className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>

        <span
          className={`inline-flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-medium ${style.badge}`}
        >
          <Icon className="h-2.5 w-2.5" />
          {style.label}
        </span>

        {isCopiedContext && (
          <span
            title={t('detail.copiedContextTitle')}
            className="inline-flex shrink-0 items-center rounded border border-orange-200 dark:border-orange-500/30 bg-orange-50 dark:bg-orange-500/15 px-1.5 py-0.5 text-[10px] font-medium text-orange-700 dark:text-orange-300"
          >
            {t('detail.copiedContext')}
          </span>
        )}

        <span className="min-w-0 flex-1 truncate font-medium" title={span.title}>
          {span.title}
        </span>

        <div className="flex shrink-0 items-center gap-2">
          {hasThinking && (
            <span
              title={t('detail.hasThinkingTitle')}
              className="inline-flex items-center rounded bg-fuchsia-50 dark:bg-fuchsia-500/15 px-1.5 py-0.5 text-[10px] text-fuchsia-700 dark:text-fuchsia-300 border border-fuchsia-200 dark:border-fuchsia-500/30"
            >
              <Brain className="h-2.5 w-2.5" />
            </span>
          )}
          {tokens > 0 && (
            <span className="font-mono text-[10px] text-slate-500 dark:text-slate-400">
              {formatNumber(tokens)} {t('detail.tokUnit')}
            </span>
          )}
          <div className="hidden sm:block w-24 h-2 rounded-full bg-slate-200 dark:bg-slate-800 overflow-hidden relative">
            <div
              className={`absolute top-0 bottom-0 rounded-full ${style.bar} opacity-85`}
              style={{
                left: `${Math.max(0, Math.min(96, timeline.startPercent))}%`,
                width: `${Math.max(4, Math.min(100, timeline.widthPercent))}%`,
              }}
            />
          </div>
          <span className="w-14 text-right font-mono text-[10px] text-slate-500">
            {formatPrismDuration(durationMs)}
          </span>
        </div>
      </div>

      {hasChildren &&
        !isCollapsed &&
        span.children!.map((child) => (
          <SpanTreeRow
            key={child.id}
            span={child}
            depth={depth + 1}
            selectedId={selectedId}
            collapsed={collapsed}
            minStart={minStart}
            maxEnd={maxEnd}
            onSelect={onSelect}
            onToggleCollapse={onToggleCollapse}
          />
        ))}
    </>
  );
}

function HeaderPillTooltip({
  label,
  value,
  subValue,
}: {
  label: string;
  value: string;
  subValue?: string;
}) {
  return (
    <span
      role="tooltip"
      className="pointer-events-none invisible opacity-0 group-hover:visible group-hover:opacity-100 transition-opacity duration-150 absolute left-0 top-full mt-1.5 z-50 w-max max-w-[min(28rem,calc(100vw-2rem))] rounded-md border border-slate-200 dark:border-slate-700 bg-slate-900 dark:bg-slate-800 px-2.5 py-1.5 text-left font-sans text-[11px] leading-snug text-white dark:text-slate-100 shadow-lg"
    >
      <span className="block text-[10px] font-medium text-slate-300 dark:text-slate-400">
        {label}
      </span>
      <span className="mt-0.5 block font-mono break-all text-white dark:text-slate-100">
        {value}
      </span>
      {subValue && (
        <span className="mt-0.5 block font-mono break-all text-sky-300">
          {subValue}
        </span>
      )}
    </span>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
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
      className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-2.5 py-1 text-xs text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-400" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
      {copied ? t('detail.copied') : label || t('detail.copy')}
    </button>
  );
}

interface ParsedToolDef {
  index: number;
  name: string;
  type: string;
  description: string;
  parameters: unknown;
  propCount: number;
  requiredCount: number;
  raw: Record<string, unknown>;
}

function parseToolDefinition(def: Record<string, unknown>, index: number): ParsedToolDef {
  const fnObj =
    def.function && typeof def.function === 'object'
      ? (def.function as Record<string, unknown>)
      : def;
  const name =
    typeof fnObj.name === 'string' && fnObj.name
      ? fnObj.name
      : typeof def.name === 'string' && def.name
        ? def.name
        : `tool_${index}`;
  const description =
    typeof fnObj.description === 'string'
      ? fnObj.description
      : typeof def.description === 'string'
        ? def.description
        : '';
  const parameters =
    fnObj.parameters !== undefined
      ? fnObj.parameters
      : def.parameters !== undefined
        ? def.parameters
        : fnObj.input_schema !== undefined
          ? fnObj.input_schema
          : def.input_schema;
  const type = typeof def.type === 'string' && def.type ? def.type : 'function';
  let propCount = 0;
  let requiredCount = 0;
  if (parameters && typeof parameters === 'object') {
    const pObj = parameters as Record<string, unknown>;
    if (pObj.properties && typeof pObj.properties === 'object') {
      propCount = Object.keys(pObj.properties as Record<string, unknown>).length;
    }
    if (Array.isArray(pObj.required)) {
      requiredCount = pObj.required.length;
    }
  }
  return {
    index,
    name,
    type,
    description,
    parameters,
    propCount,
    requiredCount,
    raw: def,
  };
}

function ToolDefinitionsPanel({
  tools,
  title,
  compact = false,
}: {
  tools: ReadonlyArray<Record<string, unknown>>;
  title?: string;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [filter, setFilter] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const parsedTools = useMemo(
    () => tools.map((def, idx) => parseToolDefinition(def, idx + 1)),
    [tools]
  );

  const filteredTools = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return parsedTools;
    return parsedTools.filter(
      (item) =>
        item.name.toLowerCase().includes(q) ||
        item.description.toLowerCase().includes(q) ||
        `#${item.index}`.includes(q)
    );
  }, [parsedTools, filter]);

  const allToolsJson = useMemo(() => JSON.stringify(tools, null, 2), [tools]);

  function toggleOne(index: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  }

  function expandAll() {
    setExpanded(new Set(filteredTools.map((item) => item.index)));
  }

  function collapseAll() {
    setExpanded(new Set());
  }

  if (tools.length === 0) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-8 text-center text-xs text-slate-500">
        {t('tools.empty')}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 overflow-hidden shadow-xs dark:shadow-none">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/90 px-4 py-2.5">
        <div className="flex items-center gap-2 text-xs">
          <Wrench className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
          <span className="font-medium text-slate-800 dark:text-slate-200">
            {title || t('tools.title')}
          </span>
          <span className="rounded border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-1.5 py-0.5 font-mono text-[10px] font-medium text-amber-800 dark:text-amber-300">
            {filteredTools.length === parsedTools.length
              ? `${parsedTools.length}`
              : `${filteredTools.length} / ${parsedTools.length}`}
          </span>
          <span className="hidden md:inline text-[11px] text-slate-500">
            {t('tools.exactOrder')}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[180px] flex-1 sm:flex-initial">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('tools.filterPlaceholder')}
              className="w-full rounded-md border border-slate-300 dark:border-slate-700/80 bg-white dark:bg-slate-950 py-1 pl-8 pr-2.5 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={expandAll}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-2 py-1 text-[11px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
          >
            {t('tools.expandAll')}
          </button>
          <button
            type="button"
            onClick={collapseAll}
            className="rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-2 py-1 text-[11px] text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
          >
            {t('tools.collapseAll')}
          </button>
          <CopyButton text={allToolsJson} label={t('detail.copyJson')} />
        </div>
      </div>

      <div className={`${compact ? 'max-h-[54vh]' : 'max-h-[70vh]'} overflow-y-auto divide-y divide-slate-200 dark:divide-slate-800/70`}>
        {filteredTools.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">
            {t('tools.noMatch', { query: filter })}
          </div>
        ) : (
          filteredTools.map((tool) => {
            const isOpen = expanded.has(tool.index);
            const schemaJson =
              tool.parameters !== undefined
                ? JSON.stringify(tool.parameters, null, 2)
                : JSON.stringify(tool.raw, null, 2);
            return (
              <div key={`${tool.index}-${tool.name}`} className="bg-white dark:bg-slate-950/40">
                <button
                  type="button"
                  onClick={() => toggleOne(tool.index)}
                  className="flex w-full items-start gap-2.5 px-4 py-2.5 text-left hover:bg-slate-50 dark:hover:bg-slate-800/40 transition-colors cursor-pointer"
                >
                  <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center text-slate-400 dark:text-slate-500">
                    {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                  </span>

                  <span className="shrink-0 rounded border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] font-medium text-slate-600 dark:text-slate-400">
                    #{tool.index}
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs font-semibold text-amber-700 dark:text-amber-300">
                        {tool.name}
                      </span>
                      {tool.type !== 'function' && (
                        <span className="rounded border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/80 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:text-slate-400">
                          {tool.type}
                        </span>
                      )}
                      {tool.propCount > 0 && (
                        <span className="rounded border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/90 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:text-slate-400">
                          {tool.propCount}{' '}
                          {tool.propCount === 1 ? t('tools.paramSingular') : t('tools.paramPlural')}
                          {tool.requiredCount > 0
                            ? ` ${t('tools.reqCount', { count: tool.requiredCount })}`
                            : ''}
                        </span>
                      )}
                    </div>
                    {tool.description && (
                      <p
                        className={`mt-1 text-xs leading-relaxed text-slate-600 dark:text-slate-400 whitespace-pre-wrap break-words ${
                          isOpen ? '' : 'line-clamp-2'
                        }`}
                      >
                        {tool.description}
                      </p>
                    )}
                  </div>
                </button>

                {isOpen && (
                  <div className="border-t border-slate-200 dark:border-slate-800/70 bg-slate-50 dark:bg-slate-950/90 px-4 py-3 pl-11 space-y-2">
                    <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400">
                      <span className="font-medium text-slate-700 dark:text-slate-300">
                        {tool.parameters !== undefined ? t('tools.schemaLabel') : t('tools.rawDefLabel')}
                      </span>
                      <CopyButton text={schemaJson} label={t('detail.copySchema')} />
                    </div>
                    <pre className="max-h-96 overflow-auto rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-950 p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200">
                      {schemaJson}
                    </pre>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function AgentOverviewPanel({ span, upstreamUrl }: { span: SpanNode; upstreamUrl?: string }) {
  const { lang, t } = useI18n();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const meta = span.metadata;
  const durationMs = getDurationMs(span);
  const startTime =
    typeof meta?.startTime === 'string' && meta.startTime
      ? meta.startTime
      : span.startTime.toISOString();
  const endTime =
    typeof meta?.endTime === 'string' && meta.endTime
      ? meta.endTime
      : span.endTime.toISOString();
  const promptTokens = typeof meta?.promptTokens === 'number' ? meta.promptTokens : 0;
  const cachedTokens = typeof meta?.cachedTokens === 'number' ? meta.cachedTokens : 0;
  const completionTokens = typeof meta?.completionTokens === 'number' ? meta.completionTokens : 0;
  const totalTokens = promptTokens + completionTokens;
  const costUsd = typeof meta?.costUsd === 'number' ? meta.costUsd : undefined;
  const llmCallCount = typeof meta?.llmCallCount === 'number' ? meta.llmCallCount : undefined;
  const subagentCount = typeof meta?.subagentCount === 'number' ? meta.subagentCount : undefined;

  const coreRows: Array<{ label: string; value: string; highlight?: boolean; fullWidth?: boolean; copyText?: string; title?: string }> = [
    ...(typeof meta?.sessionId === 'string' && meta.sessionId
      ? [{ label: t('detail.metaSessionId'), value: meta.sessionId }]
      : []),
    ...(typeof meta?.trajectoryId === 'string' && meta.trajectoryId
      ? [{ label: t('detail.metaTrajectoryId'), value: meta.trajectoryId }]
      : []),
    ...(typeof meta?.continuedTrajectoryRef === 'string' && meta.continuedTrajectoryRef
      ? [{ label: t('detail.metaContinuedRef'), value: meta.continuedTrajectoryRef }]
      : []),
    ...(typeof meta?.schemaVersion === 'string' && meta.schemaVersion
      ? [{ label: t('detail.metaSchemaVersion'), value: meta.schemaVersion }]
      : []),
    ...(typeof meta?.harness === 'string' && meta.harness
      ? [{ label: t('detail.metaHarness'), value: meta.harness }]
      : []),
    ...(typeof meta?.agentName === 'string' && meta.agentName
      ? [
          {
            label: t('detail.metaAgent'),
            value: `${meta.agentName}${typeof meta.agentVersion === 'string' && meta.agentVersion ? ` v${meta.agentVersion}` : ''}`,
          },
        ]
      : []),
    ...(typeof meta?.upstream === 'string' && meta.upstream
      ? [{ label: t('detail.metaUpstream'), value: meta.upstream, title: upstreamUrl || undefined }]
      : []),
    ...(typeof meta?.clientIp === 'string' && meta.clientIp
      ? [{ label: t('detail.metaClientIp'), value: meta.clientIp }]
      : []),
    ...(typeof meta?.workDir === 'string' && meta.workDir
      ? [{ label: t('detail.metaWorkDir'), value: meta.workDir }]
      : []),
    ...(typeof meta?.modelName === 'string' && meta.modelName
      ? [{ label: t('detail.metaRequestedModel'), value: meta.modelName }]
      : []),
    ...(typeof meta?.responseModel === 'string' && meta.responseModel
      ? [{ label: t('detail.metaResponseModel'), value: meta.responseModel, highlight: true }]
      : []),
    ...(llmCallCount !== undefined
      ? [{ label: t('detail.metaLlmCalls'), value: formatNumber(llmCallCount), highlight: true }]
      : []),
    ...(subagentCount !== undefined
      ? [{ label: t('detail.metaSubagents'), value: formatNumber(subagentCount), highlight: subagentCount > 0 }]
      : []),
    { label: t('detail.metaStartTime'), value: formatFullTimestamp(startTime, locale) },
    { label: t('detail.metaEndTime'), value: formatFullTimestamp(endTime, locale) },
    { label: t('detail.metaDuration'), value: formatDuration(durationMs) },
    {
      label: t('detail.metaTotalTokens'),
      value: `${formatNumber(totalTokens)} (${t('detail.metaPrompt')}: ${formatNumber(promptTokens)}, ${t('detail.metaCached')}: ${formatNumber(cachedTokens)} · ${formatCacheHitRate(cachedTokens, promptTokens)}, ${t('detail.metaCompletion')}: ${formatNumber(completionTokens)})`,
    },
    ...(costUsd !== undefined ? [{ label: t('detail.metaCost'), value: `$${costUsd.toFixed(5)}` }] : []),
    ...(typeof meta?.apiKeyHash === 'string' && meta.apiKeyHash
      ? [
          {
            label: t('detail.metaApiKeyHash'),
            value: meta.apiKeyHash,
            fullWidth: true,
            copyText: meta.apiKeyHash,
          },
        ]
      : []),
  ];

  const extraEntries = Object.entries((meta?.extraFields as Record<string, unknown> | undefined) ?? {}).filter(
    ([k, v]) => !ROOT_KNOWN_EXTRA_KEYS.has(k) && v !== undefined && v !== null && v !== ''
  );

  return (
    <div className="space-y-3">
      <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 overflow-hidden">
        <div className="border-b border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300">
          {t('detail.metaSessionSummary')}
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-slate-200 dark:bg-slate-800/70">
          {coreRows.map((row) => (
            <div
              key={row.label}
              className={`bg-white dark:bg-slate-950/90 px-3 py-2 text-xs ${row.fullWidth ? 'sm:col-span-2' : ''}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400">
                  {row.label}
                </div>
                {row.copyText && <CopyButton text={row.copyText} />}
              </div>
              <div
                title={row.title}
                className={`mt-0.5 font-mono break-all ${
                  row.highlight
                    ? 'font-semibold text-emerald-700 dark:text-emerald-300'
                    : 'text-slate-800 dark:text-slate-200'
                }`}
              >
                {row.value}
              </div>
            </div>
          ))}
        </div>
      </div>

      {extraEntries.length > 0 && (
        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/70 overflow-hidden">
          <div className="border-b border-slate-200 dark:border-slate-800 px-3 py-2 text-xs font-medium text-slate-700 dark:text-slate-300">
            {t('detail.metaExtraFields')}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-slate-200 dark:bg-slate-800/70">
            {extraEntries.map(([key, val]) => (
              <div key={key} className="bg-white dark:bg-slate-950/90 px-3 py-2 text-xs">
                <div className="font-mono text-[10px] text-slate-500 dark:text-slate-400">{key}</div>
                <div className="mt-0.5 font-mono text-slate-800 dark:text-slate-200 break-all">
                  {formatExtraValue(val)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LlmMetadataStrip({
  span,
  upstreamUrl,
  onOpenHttp,
}: {
  span: SpanNode;
  upstreamUrl?: string;
  onOpenHttp?: () => void;
}) {
  const { t } = useI18n();
  const meta = span.metadata;
  const requestedModel = typeof meta?.requestedModel === 'string' ? meta.requestedModel : typeof meta?.modelName === 'string' ? meta.modelName : undefined;
  const responseModel = typeof meta?.responseModel === 'string' ? meta.responseModel : undefined;
  const responseId = typeof meta?.responseId === 'string' ? meta.responseId : undefined;
  const finishReason = typeof meta?.finishReason === 'string' ? meta.finishReason : undefined;
  const statusCode = typeof meta?.statusCode === 'number' ? meta.statusCode : undefined;
  const latencyMs = typeof meta?.latencyMs === 'number' ? meta.latencyMs : undefined;
  const isStream = typeof meta?.isStream === 'boolean' ? meta.isStream : undefined;
  const upstream = typeof meta?.upstream === 'string' ? meta.upstream : undefined;
  const httpMethod = typeof meta?.httpMethod === 'string' ? meta.httpMethod : undefined;
  const httpPath = typeof meta?.httpPath === 'string' ? meta.httpPath : undefined;
  const requestId = typeof meta?.requestId === 'string' ? meta.requestId : undefined;
  const stepSourceMeta = typeof meta?.stepSourceMeta === 'string' ? meta.stepSourceMeta : undefined;
  const clientIp = typeof meta?.clientIp === 'string' ? meta.clientIp : undefined;
  const apiKeyHash = typeof meta?.apiKeyHash === 'string' ? meta.apiKeyHash : undefined;
  const promptTokens = typeof meta?.promptTokens === 'number' ? meta.promptTokens : undefined;
  const cachedTokens = typeof meta?.cachedTokens === 'number' ? meta.cachedTokens : 0;
  const cacheCreationTokens = typeof meta?.cacheCreationTokens === 'number' ? meta.cacheCreationTokens : undefined;
  const completionTokens = typeof meta?.completionTokens === 'number' ? meta.completionTokens : undefined;
  const reasoningTokens =
    typeof meta?.reasoningTokens === 'number'
      ? meta.reasoningTokens
      : typeof span.reasoning?.tokens === 'number'
        ? span.reasoning.tokens
        : undefined;
  const costUsd = typeof meta?.costUsd === 'number' ? meta.costUsd : undefined;
  const hasHttp = typeof meta?.requestRecordId === 'number';

  const extraEntries = Object.entries((meta?.extraFields as Record<string, unknown> | undefined) ?? {}).filter(
    ([k, v]) => !LLM_KNOWN_EXTRA_KEYS.has(k) && v !== undefined && v !== null && v !== ''
  );
  const hasHeaderRow = Boolean(
    requestedModel ||
      responseModel ||
      finishReason ||
      statusCode !== undefined ||
      latencyMs !== undefined ||
      isStream !== undefined ||
      (hasHttp && onOpenHttp)
  );
  const hasMetaRow = Boolean(
    responseId || upstream || httpMethod || httpPath || requestId || stepSourceMeta || clientIp
  );
  const hasTokenMetrics = Boolean(
    span.tokenUsage !== undefined ||
      promptTokens !== undefined ||
      completionTokens !== undefined ||
      (cacheCreationTokens !== undefined && cacheCreationTokens > 0) ||
      (reasoningTokens !== undefined && reasoningTokens > 0) ||
      costUsd !== undefined
  );

  if (!hasHeaderRow && !hasMetaRow && !apiKeyHash && !hasTokenMetrics && extraEntries.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-950/80 p-3 space-y-2.5 text-xs">
      {hasHeaderRow && (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          {requestedModel && (
            <span className="inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300">
              <span className="text-slate-400 dark:text-slate-500">{t('detail.metaRequestedModel')}:</span>
              <span className="font-medium text-slate-900 dark:text-slate-100">{requestedModel}</span>
            </span>
          )}
          {responseModel && (
            <span className="inline-flex items-center gap-1 rounded-md border border-emerald-200 dark:border-emerald-500/35 bg-emerald-50 dark:bg-emerald-500/15 px-2 py-0.5 font-mono text-[11px] text-emerald-800 dark:text-emerald-200">
              <span className="text-emerald-600/80 dark:text-emerald-400/80">{t('detail.metaResponseModel')}:</span>
              <span className="font-semibold">{responseModel}</span>
            </span>
          )}
          {finishReason && (
            <span className="inline-flex items-center gap-1 rounded-md border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/15 px-2 py-0.5 font-mono text-[11px] text-violet-700 dark:text-violet-300">
              <span className="text-violet-500/80 dark:text-violet-400/80">{t('detail.metaFinishReason')}:</span>
              <span className="font-medium">{finishReason}</span>
            </span>
          )}
          {statusCode !== undefined && (
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold ${httpStatusPillClass(
                statusCode
              )}`}
            >
              HTTP {statusCode}
            </span>
          )}
          {latencyMs !== undefined && (
            <span className="inline-flex items-center rounded-md border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300">
              {formatNumber(latencyMs)} ms
            </span>
          )}
          {isStream !== undefined && (
            <span
              className={`inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[10px] font-medium ${
                isStream
                  ? 'border-cyan-200 bg-cyan-50 text-cyan-700 dark:border-cyan-500/30 dark:bg-cyan-500/15 dark:text-cyan-300'
                  : 'border-slate-200 bg-white text-slate-600 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400'
              }`}
            >
              {isStream ? t('detail.metaStreamSse') : t('detail.metaNonStream')}
            </span>
          )}
        </div>

        {hasHttp && onOpenHttp && (
          <button
            type="button"
            onClick={onOpenHttp}
            className="inline-flex items-center gap-1 rounded-md border border-indigo-200 dark:border-indigo-500/40 bg-indigo-50 dark:bg-indigo-500/15 px-2 py-0.5 text-[11px] font-medium text-indigo-700 dark:text-indigo-300 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 transition-colors cursor-pointer"
          >
            <Globe className="h-3 w-3" />
            {t('detail.metaOpenHttp')}
          </button>
        )}
      </div>
      )}

      {hasMetaRow && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600 dark:text-slate-400">
          {responseId && (
            <span>
              <span className="text-slate-500">{t('detail.metaResponseId')}:</span>{' '}
              <span className="font-mono text-slate-800 dark:text-slate-200">{responseId}</span>
            </span>
          )}
          {upstream && (
            <span title={upstreamUrl || undefined}>
              <span className="text-slate-500">{t('detail.metaUpstream')}:</span>{' '}
              <span className="font-mono text-slate-800 dark:text-slate-200">{upstream}</span>
            </span>
          )}
          {(httpMethod || httpPath) && (
            <span>
              <span className="text-slate-500">{t('detail.metaEndpoint')}:</span>{' '}
              <span className="font-mono text-slate-800 dark:text-slate-200">
                {[httpMethod, httpPath].filter(Boolean).join(' ')}
              </span>
            </span>
          )}
          {requestId && (
            <span>
              <span className="text-slate-500">{t('detail.metaRequestId')}:</span>{' '}
              <span className="font-mono text-slate-800 dark:text-slate-200">{requestId}</span>
            </span>
          )}
          {stepSourceMeta && (
            <span>
              <span className="text-slate-500">{t('detail.metaSource')}:</span>{' '}
              <span className="font-mono text-slate-800 dark:text-slate-200">{stepSourceMeta}</span>
            </span>
          )}
          {clientIp && (
            <span className="inline-flex items-center gap-1">
              <Network className="h-3 w-3 text-slate-400 dark:text-slate-500" />
              <span className="text-slate-500">{t('detail.metaClientIp')}:</span>{' '}
              <span className="font-mono text-slate-800 dark:text-slate-200">{clientIp}</span>
            </span>
          )}
        </div>
      )}

      {apiKeyHash && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-200/80 dark:border-slate-800/80 pt-2 text-[11px]">
          <div className="flex items-start gap-1.5 min-w-0 flex-1">
            <KeyRound className="mt-0.5 h-3 w-3 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="shrink-0 text-slate-500">{t('detail.metaApiKeyHash')}:</span>
            <span className="font-mono text-slate-800 dark:text-slate-200 break-all">
              {apiKeyHash}
            </span>
          </div>
          <CopyButton text={apiKeyHash} />
        </div>
      )}

      {hasTokenMetrics && (
      <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-200/80 dark:border-slate-800/80 pt-2">
        {promptTokens !== undefined && (
          <span className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-2 py-0.5 font-mono text-[11px]">
            <span className="text-slate-500">{t('detail.metaPrompt')}:</span>
            <span className="font-medium text-slate-800 dark:text-slate-200">
              {formatNumber(promptTokens)}
            </span>
          </span>
        )}
        <span className="inline-flex items-center gap-1 rounded border border-sky-200 dark:border-sky-500/30 bg-sky-50 dark:bg-sky-500/10 px-2 py-0.5 font-mono text-[11px]">
          <span className="text-sky-600 dark:text-sky-400">{t('detail.metaCached')}:</span>
          <span className="font-medium text-sky-800 dark:text-sky-200">
            {formatNumber(cachedTokens)} ({formatCacheHitRate(cachedTokens, promptTokens)})
          </span>
        </span>
        {cacheCreationTokens !== undefined && cacheCreationTokens > 0 && (
          <span className="inline-flex items-center gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/10 px-2 py-0.5 font-mono text-[11px]">
            <span className="text-indigo-600 dark:text-indigo-400">{t('detail.metaCacheWrite')}:</span>
            <span className="font-medium text-indigo-800 dark:text-indigo-200">
              {formatNumber(cacheCreationTokens)}
            </span>
          </span>
        )}
        {completionTokens !== undefined && (
          <span className="inline-flex items-center gap-1 rounded border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/10 px-2 py-0.5 font-mono text-[11px]">
            <span className="text-emerald-600 dark:text-emerald-400">{t('detail.metaCompletion')}:</span>
            <span className="font-medium text-emerald-800 dark:text-emerald-200">
              {formatNumber(completionTokens)}
            </span>
          </span>
        )}
        {reasoningTokens !== undefined && reasoningTokens > 0 && (
          <span className="inline-flex items-center gap-1 rounded border border-fuchsia-200 dark:border-fuchsia-500/30 bg-fuchsia-50 dark:bg-fuchsia-500/10 px-2 py-0.5 font-mono text-[11px]">
            <span className="text-fuchsia-600 dark:text-fuchsia-400">{t('detail.metaReasoning')}:</span>
            <span className="font-medium text-fuchsia-800 dark:text-fuchsia-200">
              {formatNumber(reasoningTokens)}
            </span>
          </span>
        )}
        {costUsd !== undefined && (
          <span className="inline-flex items-center gap-1 rounded border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-2 py-0.5 font-mono text-[11px]">
            <span className="text-amber-700 dark:text-amber-400">{t('detail.metaCost')}:</span>
            <span className="font-medium text-amber-800 dark:text-amber-200">
              ${costUsd.toFixed(5)}
            </span>
          </span>
        )}
      </div>
      )}

      {extraEntries.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-slate-200/80 dark:border-slate-800/80 pt-2">
          {extraEntries.map(([k, v]) => (
            <span
              key={k}
              className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:text-slate-400"
            >
              <span className="text-slate-400 dark:text-slate-500">{k}:</span>
              <span className="text-slate-800 dark:text-slate-200 break-all">{formatExtraValue(v)}</span>
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolMetadataStrip({ span }: { span: SpanNode }) {
  const { t } = useI18n();
  const meta = span.metadata;
  const fnName = typeof meta?.functionName === 'string' ? meta.functionName : undefined;
  const callId = typeof meta?.toolCallId === 'string' ? meta.toolCallId : undefined;
  const rawCallId = typeof meta?.rawToolCallId === 'string' ? meta.rawToolCallId : undefined;
  const subagentRefs = Array.isArray(meta?.subagentRefs)
    ? (meta.subagentRefs as ReadonlyArray<{ trajectory_id?: string; trajectory_path?: string; session_id?: string }>)
    : [];
  const extraEntries = Object.entries((meta?.extraFields as Record<string, unknown> | undefined) ?? {}).filter(
    ([k, v]) => k !== 'raw_tool_call_id' && v !== undefined && v !== null && v !== ''
  );

  if (!fnName && !callId && !rawCallId && subagentRefs.length === 0 && extraEntries.length === 0) {
    return null;
  }

  return (
    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-950/80 p-3 flex flex-wrap items-center gap-2 text-[11px]">
      {fnName && (
        <span className="inline-flex items-center gap-1 rounded border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/15 px-2 py-0.5 font-mono text-amber-800 dark:text-amber-300">
          <span className="text-amber-600/80 dark:text-amber-400/80">{t('detail.metaFunctionName')}:</span>
          <span className="font-semibold">{fnName}</span>
        </span>
      )}
      {callId && (
        <span className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 font-mono text-slate-700 dark:text-slate-300">
          <span className="text-slate-400 dark:text-slate-500">{t('detail.metaToolCallId')}:</span>
          <span>{callId}</span>
        </span>
      )}
      {rawCallId && rawCallId !== callId && (
        <span className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-0.5 font-mono text-slate-700 dark:text-slate-300">
          <span className="text-slate-400 dark:text-slate-500">{t('detail.metaRawToolCallId')}:</span>
          <span>{rawCallId}</span>
        </span>
      )}
      {subagentRefs.map((ref, idx) => {
        const refLabel = ref.session_id || ref.trajectory_id || ref.trajectory_path || `#${idx + 1}`;
        return (
          <span
            key={`${refLabel}-${idx}`}
            className="inline-flex items-center gap-1 rounded border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 px-2 py-0.5 font-mono text-indigo-700 dark:text-indigo-300"
          >
            <span className="text-indigo-500/80 dark:text-indigo-400/80">{t('detail.metaSubagentRef')}:</span>
            <span>{refLabel}</span>
          </span>
        );
      })}
      {extraEntries.map(([k, v]) => (
        <span
          key={k}
          className="inline-flex items-center gap-1 rounded border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-1.5 py-0.5 font-mono text-[10px] text-slate-600 dark:text-slate-400"
        >
          <span className="text-slate-400 dark:text-slate-500">{k}:</span>
          <span className="text-slate-800 dark:text-slate-200 break-all">{formatExtraValue(v)}</span>
        </span>
      ))}
    </div>
  );
}

export function TraceDetail({
  sessionId,
  onBack,
  onExport,
  onUnauthorized,
}: TraceDetailProps) {
  const { lang, t } = useI18n();
  const locale = lang === 'zh' ? 'zh-CN' : 'en-US';
  const [trajectories, setTrajectories] = useState<AtifTrajectory[]>([]);
  const [upstreamUrl, setUpstreamUrl] = useState<string>('');
  const [sessionLlmCallCount, setSessionLlmCallCount] = useState<number | undefined>(undefined);
  const [selectedSegmentIdx, setSelectedSegmentIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>('prism');
  const [searchQuery, setSearchQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [trajGridExpanded, setTrajGridExpanded] = useState(false);
  const httpCacheRef = useRef<Map<number, RawRequestDetail>>(new Map());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setTrajectories([]);
    setUpstreamUrl('');
    setSessionLlmCallCount(undefined);
    setSelectedSegmentIdx(0);
    setViewMode('prism');
    setSelectedSpanId(null);
    setActiveTab('overview');
    setCollapsed(new Set());
    setTrajGridExpanded(false);
    setSearchQuery('');
    setCategoryFilter('all');

    fetchTraceTrajectories(sessionId)
      .then((res) => {
        if (cancelled) return;
        setTrajectories(res.trajectories ?? []);
        setUpstreamUrl(res.upstream_url ?? '');
        setSessionLlmCallCount(res.llm_call_count);
        setSelectedSegmentIdx(0);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          onUnauthorized?.();
          return;
        }
        setError(err instanceof Error ? err.message : t('detail.loadError'));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [sessionId, onUnauthorized, t]);

  const trajectory = trajectories[selectedSegmentIdx] ?? trajectories[0] ?? null;

  function handleSelectSegment(index: number) {
    if (index === selectedSegmentIdx) return;
    setSelectedSegmentIdx(index);
    setSelectedSpanId(null);
    setActiveTab('overview');
    setCollapsed(new Set());
  }

  const adapted = useMemo(() => {
    if (!trajectory) return null;
    return adaptAtifToAgentPrism(trajectory);
  }, [trajectory]);

  const sessionSummary = useMemo(
    () => summarizeSession(trajectories, sessionLlmCallCount),
    [trajectories, sessionLlmCallCount]
  );

  const trajectorySummaries = useMemo(
    () => trajectories.map((seg) => summarizeTrajectory(seg)),
    [trajectories]
  );

  const activeTrajSummary = trajectorySummaries[selectedSegmentIdx] ?? trajectorySummaries[0] ?? null;

  const filteredSpans = useMemo<readonly SpanNode[]>(() => {
    if (!adapted) return [];
    let spans: readonly SpanNode[] = adapted.spans;
    if (searchQuery.trim()) {
      spans = filterSpansRecursively(spans, searchQuery.trim());
    }
    if (categoryFilter === 'all') return spans;

    const filterByCategory = (list: readonly SpanNode[]): SpanNode[] => {
      const out: SpanNode[] = [];
      for (const s of list) {
        const kids = s.children ? filterByCategory(s.children) : [];
        if (s.type === categoryFilter || s.type === 'agent_invocation' || kids.length > 0) {
          out.push({ ...s, children: kids.length > 0 ? kids : undefined });
        }
      }
      return out;
    };
    return filterByCategory(spans);
  }, [adapted, searchQuery, categoryFilter]);

  const flatSpans = useMemo(() => {
    if (!adapted) return [];
    return flattenSpans(adapted.spans);
  }, [adapted]);

  const selectedSpan = useMemo(() => {
    if (flatSpans.length === 0) return null;
    if (selectedSpanId) {
      const found = flatSpans.find((s) => s.id === selectedSpanId);
      if (found) return found;
    }
    return flatSpans.length > 1 ? flatSpans[1] : flatSpans[0];
  }, [flatSpans, selectedSpanId]);

  const timeRange = useMemo(() => {
    if (!adapted || adapted.spans.length === 0) {
      const now = Date.now();
      return { minStart: now, maxEnd: now + 1000 };
    }
    return findTimeRange(adapted.spans);
  }, [adapted]);

  const rawAtifJson = useMemo(() => {
    if (!trajectory) return '';
    return JSON.stringify(trajectory, null, 2);
  }, [trajectory]);

  function handleToggleCollapse(id: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleSelectSpan(span: SpanNode) {
    setSelectedSpanId(span.id);
    const hasHttp =
      span.type === 'llm_call' && typeof span.metadata?.requestRecordId === 'number';
    const hasTools =
      Array.isArray(span.metadata?.toolDefinitions) && span.metadata.toolDefinitions.length > 0;
    if (activeTab === 'http' && !hasHttp) {
      setActiveTab('overview');
    } else if (activeTab === 'tools' && !hasTools) {
      setActiveTab('overview');
    }
  }

  if (loading) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 p-12 text-center text-slate-500 dark:text-slate-400">
        {t('detail.loading')}{' '}
        <span className="font-mono text-slate-800 dark:text-slate-200">{sessionId}</span>...
      </div>
    );
  }

  if (error || !trajectory || !adapted) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-3 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          {t('detail.backToTraces')}
        </button>
        <div className="rounded-xl border border-rose-200 dark:border-rose-500/30 bg-rose-50 dark:bg-rose-500/10 p-6 text-sm text-rose-700 dark:text-rose-300">
          {error || t('detail.loadError')}
        </div>
      </div>
    );
  }

  const selectedSourceStr =
    selectedSpan && typeof selectedSpan.metadata?.source === 'string'
      ? selectedSpan.metadata.source
      : undefined;
  const trajectoryToolDefs = Array.isArray(trajectory.agent?.tool_definitions)
    ? trajectory.agent.tool_definitions
    : [];
  const selectedSpanToolDefs =
    selectedSpan && Array.isArray(selectedSpan.metadata?.toolDefinitions)
      ? (selectedSpan.metadata.toolDefinitions as ReadonlyArray<Record<string, unknown>>)
      : [];
  const selectedRequestRecordId =
    selectedSpan &&
    selectedSpan.type === 'llm_call' &&
    typeof selectedSpan.metadata?.requestRecordId === 'number'
      ? selectedSpan.metadata.requestRecordId
      : undefined;

  const spanTabs: Array<[DetailTab, string]> = selectedSpan
    ? [
        ['overview', t('detail.tabOverview')],
        ...(selectedRequestRecordId !== undefined
          ? ([['http', t('detail.tabHttp')]] as Array<[DetailTab, string]>)
          : []),
        ...(selectedSpanToolDefs.length > 0
          ? ([['tools', t('detail.tabTools', { count: selectedSpanToolDefs.length })]] as Array<
              [DetailTab, string]
            >)
          : []),
        ['attributes', t('detail.tabAttributes')],
        ['raw', t('detail.tabRaw')],
      ]
    : [];

  const sessionTotalTokens =
    sessionSummary.totalPromptTokens + sessionSummary.totalCompletionTokens;
  const sessionCacheHitRate = formatCacheHitRate(
    sessionSummary.totalCachedTokens,
    sessionSummary.totalPromptTokens
  );
  const activeTrajDurationMs =
    activeTrajSummary && activeTrajSummary.durationMs > 0
      ? activeTrajSummary.durationMs
      : adapted.record.durationMs;
  const activeTrajPromptTokens = activeTrajSummary?.promptTokens ?? adapted.totalPromptTokens;
  const activeTrajCompletionTokens =
    activeTrajSummary?.completionTokens ?? adapted.totalCompletionTokens;
  const activeTrajCachedTokens = activeTrajSummary?.cachedTokens ?? adapted.totalCachedTokens;
  const activeTrajLlmCalls = activeTrajSummary?.llmCallCount ?? adapted.llmCallCount;
  const activeTrajSubagentCount = activeTrajSummary?.subagentCount ?? adapted.subagentCount;
  const activeTrajCacheHitRate = formatCacheHitRate(
    activeTrajCachedTokens,
    activeTrajPromptTokens
  );
  const activeTrajTitle = t('detail.trajectoryLabel', { index: selectedSegmentIdx + 1 });
  const activeTrajStartTime =
    activeTrajSummary?.startTime ??
    (activeTrajSummary?.startMs !== undefined
      ? new Date(activeTrajSummary.startMs).toISOString()
      : adapted.spans[0]?.startTime.toISOString());
  const activeTrajEndTime =
    activeTrajSummary?.endTime ??
    (activeTrajSummary?.endMs !== undefined
      ? new Date(activeTrajSummary.endMs).toISOString()
      : adapted.spans[0]?.endTime.toISOString());
  const visibleTrajectories =
    !trajGridExpanded && trajectories.length > 8 ? trajectories.slice(0, 8) : trajectories;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 p-4 shadow-xs dark:shadow-none">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={onBack}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
              >
                <ArrowLeft className="h-3.5 w-3.5" />
                {t('detail.traces')}
              </button>

              <h2 className="font-mono text-sm font-semibold text-slate-900 dark:text-slate-100 break-all">
                {sessionId}
              </h2>

              <CopyButton text={sessionId} />

              <span
                title={`${t('detail.pillHarness')}: ${sessionSummary.harness}${sessionSummary.agentVersion && sessionSummary.agentVersion !== 'unknown' ? ` v${sessionSummary.agentVersion}` : ''}`}
                className={`relative group inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium ${harnessBadgeColor(
                  sessionSummary.harness
                )}`}
              >
                <span>{sessionSummary.harness}</span>
                {sessionSummary.agentVersion && sessionSummary.agentVersion !== 'unknown' && (
                  <span className="opacity-75 font-mono text-[11px]">
                    v{sessionSummary.agentVersion}
                  </span>
                )}
                <HeaderPillTooltip
                  label={t('detail.pillHarness')}
                  value={`${sessionSummary.harness}${sessionSummary.agentVersion && sessionSummary.agentVersion !== 'unknown' ? ` v${sessionSummary.agentVersion}` : ''}`}
                />
              </span>

              <span
                title={`${t('detail.pillSchema')}: ${sessionSummary.schemaVersion}`}
                className="relative group rounded-md border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-800/80 px-2 py-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300"
              >
                {sessionSummary.schemaVersion}
                <HeaderPillTooltip
                  label={t('detail.pillSchema')}
                  value={sessionSummary.schemaVersion}
                />
              </span>
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              {sessionSummary.upstream && (
                <span
                  title={
                    upstreamUrl
                      ? `${t('detail.pillUpstream')}: ${sessionSummary.upstream} — ${upstreamUrl}`
                      : `${t('detail.pillUpstream')}: ${sessionSummary.upstream}`
                  }
                  className="relative group inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/70 px-2 py-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300"
                >
                  <Server className="h-3 w-3 text-slate-400 dark:text-slate-500" />
                  {sessionSummary.upstream}
                  <HeaderPillTooltip
                    label={t('detail.pillUpstream')}
                    value={sessionSummary.upstream}
                    subValue={upstreamUrl || undefined}
                  />
                </span>
              )}

              {sessionSummary.modelName && (
                <span
                  title={`${t('detail.pillModel')}: ${sessionSummary.modelName}`}
                  className="relative group inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/70 px-2 py-0.5 font-mono text-[11px] text-slate-800 dark:text-slate-200"
                >
                  <Cpu className="h-3 w-3 text-indigo-500 dark:text-indigo-400" />
                  {sessionSummary.modelName}
                  <HeaderPillTooltip
                    label={t('detail.pillModel')}
                    value={sessionSummary.modelName}
                  />
                </span>
              )}

              {sessionSummary.apiKeyHash && (
                <span
                  title={`${t('detail.pillApiKeyHash')}: ${sessionSummary.apiKeyHash}`}
                  className="relative group inline-flex items-center gap-1 rounded-md border border-amber-200 dark:border-amber-500/30 bg-amber-50 dark:bg-amber-500/10 px-2 py-0.5 font-mono text-[11px] font-medium text-amber-800 dark:text-amber-300"
                >
                  <KeyRound className="h-3 w-3 text-amber-600 dark:text-amber-400" />
                  {shortApiKeyHash(sessionSummary.apiKeyHash)}
                  <HeaderPillTooltip
                    label={t('detail.pillApiKeyHash')}
                    value={sessionSummary.apiKeyHash}
                  />
                </span>
              )}

              {sessionSummary.clientIp && (
                <span
                  title={`${t('detail.pillClientIp')}: ${sessionSummary.clientIp}`}
                  className="relative group inline-flex items-center gap-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/70 px-2 py-0.5 font-mono text-[11px] text-slate-700 dark:text-slate-300"
                >
                  <Network className="h-3 w-3 text-slate-400 dark:text-slate-500" />
                  {sessionSummary.clientIp}
                  <HeaderPillTooltip
                    label={t('detail.pillClientIp')}
                    value={sessionSummary.clientIp}
                  />
                </span>
              )}

              {sessionSummary.workDir && (
                <span
                  title={`${t('detail.pillWorkDir')}: ${sessionSummary.workDir}`}
                  className="relative group inline-flex max-w-full items-center gap-1.5 rounded-md border border-slate-200/80 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/50 px-2 py-0.5 font-mono text-[11px] text-slate-600 dark:text-slate-400"
                >
                  <FolderOpen className="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500" />
                  <span className="truncate">{sessionSummary.workDir}</span>
                  <HeaderPillTooltip
                    label={t('detail.pillWorkDir')}
                    value={sessionSummary.workDir}
                  />
                </span>
              )}
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            <button
              type="button"
              onClick={() => onExport(sessionId)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition-colors cursor-pointer"
            >
              <Download className="h-3.5 w-3.5" />
              {t('detail.exportJsonl')}
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-950/70 px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <Clock className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
              <span>{t('detail.sessionDuration')}</span>
            </div>
            <div className="mt-1 flex items-baseline gap-2 font-mono">
              <span className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {formatDuration(sessionSummary.durationMs)}
              </span>
              {sessionSummary.totalCostUsd !== undefined && (
                <span className="text-xs font-medium text-amber-600 dark:text-amber-300">
                  ${sessionSummary.totalCostUsd.toFixed(4)}
                </span>
              )}
            </div>
            {sessionSummary.startMs !== undefined && sessionSummary.endMs !== undefined && (
              <div className="mt-0.5 truncate font-mono text-[10px] text-slate-500 dark:text-slate-400">
                {formatTimestamp(new Date(sessionSummary.startMs).toISOString(), locale)} →{' '}
                {formatTimestamp(new Date(sessionSummary.endMs).toISOString(), locale)}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-950/70 px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <Sparkles className="h-3.5 w-3.5 text-violet-500 dark:text-violet-400" />
              <span>{t('detail.sessionLlmCalls')}</span>
            </div>
            <div className="mt-1 flex items-baseline gap-2 font-mono">
              <span className="text-base font-semibold text-violet-700 dark:text-violet-300">
                {formatNumber(sessionSummary.llmCallCount)}
              </span>
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                {sessionSummary.llmCallCount === 1
                  ? t('list.llmCallSingular')
                  : t('list.llmCallPlural')}
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-950/70 px-3.5 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
                <Database className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                <span>{t('detail.sessionTokens')}</span>
              </div>
              <span
                title={t('list.cacheHitRate')}
                className="rounded border border-sky-200 dark:border-sky-500/30 bg-sky-50 dark:bg-sky-500/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-sky-700 dark:text-sky-300"
              >
                {t('list.cacheHitRate')} {sessionCacheHitRate}
              </span>
            </div>
            <div className="mt-1 font-mono text-base font-semibold text-slate-900 dark:text-slate-100">
              {formatNumber(sessionTotalTokens)}
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px]">
              <span className="text-slate-600 dark:text-slate-300">
                <span className="text-slate-400 dark:text-slate-500">{t('detail.metaPrompt')}:</span>{' '}
                {formatNumber(sessionSummary.totalPromptTokens)}
              </span>
              <span className="text-emerald-700 dark:text-emerald-400">
                <span className="text-emerald-600/70 dark:text-emerald-500/80">
                  {t('detail.metaCompletion')}:
                </span>{' '}
                {formatNumber(sessionSummary.totalCompletionTokens)}
              </span>
              <span className="text-sky-700 dark:text-sky-300">
                <span className="text-sky-600/70 dark:text-sky-400/80">
                  {t('detail.metaCached')}:
                </span>{' '}
                {formatNumber(sessionSummary.totalCachedTokens)}
              </span>
            </div>
          </div>

          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/90 dark:bg-slate-950/70 px-3.5 py-2.5">
            <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500 dark:text-slate-400">
              <Layers className="h-3.5 w-3.5 text-indigo-500 dark:text-indigo-400" />
              <span>{t('detail.sessionTrajectories')}</span>
            </div>
            <div className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-0.5 font-mono">
              <span className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {sessionSummary.trajectoryCount === 1
                  ? t('detail.trajectoryUnitSingular')
                  : t('detail.trajectoriesUnit', {
                      count: formatNumber(sessionSummary.trajectoryCount),
                    })}
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5 font-mono text-[11px] text-slate-500 dark:text-slate-400">
              <span>
                {formatNumber(sessionSummary.totalSteps)}{' '}
                {sessionSummary.totalSteps === 1 ? t('detail.stepSingular') : t('detail.stepPlural')}
              </span>
              {sessionSummary.subagentCount > 0 && (
                <span className="rounded border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 px-1.5 py-0.25 text-[10px] font-medium text-indigo-700 dark:text-indigo-300">
                  {sessionSummary.subagentCount === 1
                    ? t('detail.subagentBadgeSingular')
                    : t('detail.subagentsBadge', {
                        count: formatNumber(sessionSummary.subagentCount),
                      })}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {trajectories.length > 1 && (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 px-4 py-3 shadow-xs dark:shadow-none">
          <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="flex items-center gap-2 font-medium text-slate-700 dark:text-slate-300">
              <Link2 className="h-3.5 w-3.5 text-violet-600 dark:text-violet-400" />
              <span>{t('detail.selectTrajectory')}</span>
              <span className="rounded border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                {t('detail.segmentsCount', { count: trajectories.length })}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-500 dark:text-slate-400">
                {t('detail.viewingSegment', {
                  current: selectedSegmentIdx + 1,
                  total: trajectories.length,
                })}
              </span>
              {trajectories.length > 8 && (
                <button
                  type="button"
                  onClick={() => setTrajGridExpanded((prev) => !prev)}
                  className="inline-flex items-center gap-1 rounded-md border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-2 py-0.5 text-[11px] font-medium text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 cursor-pointer"
                >
                  {trajGridExpanded ? (
                    <>
                      <ChevronUp className="h-3 w-3" />
                      {t('detail.collapseTrajectories')}
                    </>
                  ) : (
                    <>
                      <ChevronDown className="h-3 w-3" />
                      {t('detail.showAllTrajectories', { count: trajectories.length })}
                    </>
                  )}
                </button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {visibleTrajectories.map((seg, idx) => {
              const active = idx === selectedSegmentIdx;
              const segLabel = t('detail.trajectoryLabel', { index: idx + 1 });
              const stats = trajectorySummaries[idx];
              const cacheRate = formatCacheHitRate(stats.cachedTokens, stats.promptTokens);
              const hasCacheHit = stats.cachedTokens > 0;
              const startVal = stats.startTime ?? stats.startMs;
              const endVal = stats.endTime ?? stats.endMs;
              const startFull = formatFullTimestamp(startVal, locale);
              const endFull = formatFullTimestamp(endVal, locale);
              const timeTooltip =
                endVal !== undefined
                  ? `${t('detail.trajStarted')}: ${startFull} · ${t('detail.trajEnded')}: ${endFull}`
                  : `${t('detail.trajStarted')}: ${startFull}`;
              return (
                <button
                  key={seg.trajectory_id || `${sessionId}-seg-${idx}`}
                  type="button"
                  onClick={() => handleSelectSegment(idx)}
                  className={`flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 text-left transition-all cursor-pointer ${
                    active
                      ? 'border-indigo-500 dark:border-indigo-400 bg-indigo-50/90 dark:bg-indigo-500/15 ring-1 ring-indigo-500/25 dark:ring-indigo-400/25 text-slate-900 dark:text-slate-100 shadow-xs'
                      : 'border-slate-200 dark:border-slate-800 bg-slate-50/80 dark:bg-slate-950/60 text-slate-700 dark:text-slate-300 hover:border-slate-300 dark:hover:border-slate-700 hover:bg-slate-100/70 dark:hover:bg-slate-900/80'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 w-full">
                    <div className="flex items-center gap-1.5 min-w-0">
                      <span
                        className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-semibold ${
                          active
                            ? 'bg-indigo-600 text-white'
                            : 'bg-slate-200/90 dark:bg-slate-800 text-slate-700 dark:text-slate-200'
                        }`}
                        title={segLabel}
                      >
                        {segLabel}
                      </span>
                    </div>
                    <span
                      title={`${t('list.cacheHitRate')}: ${cacheRate}`}
                      className={`shrink-0 rounded border px-1.5 py-0.5 font-mono text-[10px] font-medium ${
                        hasCacheHit
                          ? 'border-sky-200 dark:border-sky-500/30 bg-sky-50 dark:bg-sky-500/15 text-sky-700 dark:text-sky-300'
                          : 'border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900 text-slate-500 dark:text-slate-400'
                      }`}
                    >
                      {cacheRate}
                    </span>
                  </div>

                  <div
                    className="flex items-center justify-between gap-2 text-[11px] font-mono text-slate-600 dark:text-slate-400"
                    title={timeTooltip}
                  >
                    <span className="inline-flex items-center gap-1 min-w-0 truncate">
                      <Clock className="h-3 w-3 shrink-0 text-slate-400 dark:text-slate-500" />
                      <span className="truncate">{formatCompactTimestamp(startVal)}</span>
                    </span>
                    <span className="shrink-0 font-semibold text-slate-700 dark:text-slate-200">
                      {formatDuration(stats.durationMs)}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-1.5 text-[11px] font-mono">
                    <span className="rounded border border-violet-200 dark:border-violet-500/30 bg-violet-50 dark:bg-violet-500/15 px-1.5 py-0.25 text-[10px] font-medium text-violet-700 dark:text-violet-300">
                      {formatNumber(stats.llmCallCount)}{' '}
                      {stats.llmCallCount === 1
                        ? t('detail.callSingular')
                        : t('detail.callPlural')}
                    </span>
                    <span className="text-slate-600 dark:text-slate-400">
                      {formatNumber(stats.stepCount)}{' '}
                      {stats.stepCount === 1
                        ? t('detail.stepSingular')
                        : t('detail.stepPlural')}
                    </span>
                    <span
                      className={
                        stats.toolDefsCount > 0
                          ? 'text-amber-700 dark:text-amber-300'
                          : 'text-slate-400 dark:text-slate-500'
                      }
                    >
                      {stats.toolDefsCount === 1
                        ? t('detail.toolShortSingular')
                        : t('detail.toolsShort', { count: formatNumber(stats.toolDefsCount) })}
                    </span>
                    <span
                      className={
                        stats.subagentCount > 0
                          ? 'inline-flex items-center gap-0.5 rounded border border-indigo-200 dark:border-indigo-500/30 bg-indigo-50 dark:bg-indigo-500/15 px-1.5 py-0.25 text-[10px] font-medium text-indigo-700 dark:text-indigo-300'
                          : 'inline-flex items-center gap-0.5 rounded border border-slate-200 dark:border-slate-800 bg-white/80 dark:bg-slate-900 px-1.5 py-0.25 text-[10px] text-slate-500 dark:text-slate-400'
                      }
                    >
                      <GitBranch className="h-2.5 w-2.5" />
                      {stats.subagentCount === 1
                        ? t('detail.subagentBadgeSingular')
                        : t('detail.subagentsBadge', {
                            count: formatNumber(stats.subagentCount),
                          })}
                    </span>
                  </div>
                </button>
              );
            })}
          </div>
        </div>
      )}

      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 px-4 py-3 shadow-xs dark:shadow-none">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="inline-flex items-center rounded-md bg-indigo-600 px-2 py-0.5 text-[11px] font-semibold text-white">
                {activeTrajTitle}
              </span>
              {trajectory.trajectory_id && (
                <div className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-950/70 px-2 py-0.5 font-mono text-[11px] text-slate-600 dark:text-slate-300">
                  <span className="truncate max-w-[260px]" title={trajectory.trajectory_id}>
                    {trajectory.trajectory_id}
                  </span>
                </div>
              )}
              {trajectory.trajectory_id && <CopyButton text={trajectory.trajectory_id} />}
              {selectedSegmentIdx + 1 < trajectories.length && (
                <button
                  type="button"
                  onClick={() => handleSelectSegment(selectedSegmentIdx + 1)}
                  className="inline-flex items-center gap-1 rounded-md border border-violet-200 dark:border-violet-500/35 bg-violet-50 dark:bg-violet-500/15 px-2 py-0.5 text-[11px] font-medium text-violet-700 hover:bg-violet-100 dark:text-violet-300 dark:hover:bg-violet-500/25 transition-colors cursor-pointer"
                >
                  <span>{t('detail.nextTrajectory', { index: selectedSegmentIdx + 2 })}</span>
                  <ArrowRight className="h-3 w-3" />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs">
              {activeTrajStartTime && (
                <div
                  className="inline-flex items-center gap-1.5 font-mono"
                  title={formatFullTimestamp(activeTrajStartTime, locale)}
                >
                  <Clock className="h-3.5 w-3.5 text-slate-400 dark:text-slate-500" />
                  <span className="text-slate-500 dark:text-slate-400">
                    {t('detail.trajStarted')}:
                  </span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">
                    {formatFullTimestamp(activeTrajStartTime, locale)}
                  </span>
                </div>
              )}

              {activeTrajEndTime && (
                <div
                  className="inline-flex items-center gap-1.5 font-mono"
                  title={formatFullTimestamp(activeTrajEndTime, locale)}
                >
                  <span className="text-slate-500 dark:text-slate-400">
                    {t('detail.trajEnded')}:
                  </span>
                  <span className="font-medium text-slate-800 dark:text-slate-200">
                    {formatFullTimestamp(activeTrajEndTime, locale)}
                  </span>
                </div>
              )}

              <div className="inline-flex items-center gap-1.5 font-mono">
                <span className="text-slate-500 dark:text-slate-400">
                  {t('detail.trajDuration')}:
                </span>
                <span className="font-semibold text-slate-800 dark:text-slate-200">
                  {formatDuration(activeTrajDurationMs)}
                </span>
              </div>

              <div className="inline-flex items-center gap-1.5 font-mono">
                <Sparkles className="h-3.5 w-3.5 text-violet-500 dark:text-violet-400" />
                <span className="text-slate-500 dark:text-slate-400">
                  {t('detail.trajLlmCalls')}:
                </span>
                <span className="font-semibold text-violet-700 dark:text-violet-300">
                  {formatNumber(activeTrajLlmCalls)}
                </span>
              </div>

              <div className="inline-flex items-center gap-1.5 font-mono">
                <GitBranch
                  className={`h-3.5 w-3.5 ${
                    activeTrajSubagentCount > 0
                      ? 'text-indigo-500 dark:text-indigo-400'
                      : 'text-slate-400 dark:text-slate-500'
                  }`}
                />
                <span className="text-slate-500 dark:text-slate-400">
                  {t('detail.trajSubagents')}:
                </span>
                <span
                  className={
                    activeTrajSubagentCount > 0
                      ? 'font-semibold text-indigo-700 dark:text-indigo-300'
                      : 'font-semibold text-slate-700 dark:text-slate-300'
                  }
                >
                  {formatNumber(activeTrajSubagentCount)}
                </span>
              </div>

              <div className="inline-flex flex-wrap items-center gap-1.5 font-mono">
                <Database className="h-3.5 w-3.5 text-sky-500 dark:text-sky-400" />
                <span className="text-slate-500 dark:text-slate-400">
                  {t('detail.trajTokens')}:
                </span>
                <span className="text-slate-800 dark:text-slate-200">
                  {t('detail.metaPrompt')}{' '}
                  <span className="font-semibold">{formatNumber(activeTrajPromptTokens)}</span>
                </span>
                <span className="text-slate-300 dark:text-slate-700">/</span>
                <span className="text-emerald-700 dark:text-emerald-400">
                  {t('detail.metaCompletion')}{' '}
                  <span className="font-semibold">{formatNumber(activeTrajCompletionTokens)}</span>
                </span>
                <span className="text-slate-300 dark:text-slate-700">/</span>
                <span className="text-sky-700 dark:text-sky-300">
                  {t('detail.metaCached')}{' '}
                  <span className="font-semibold">
                    {formatNumber(activeTrajCachedTokens)} ({activeTrajCacheHitRate})
                  </span>
                </span>
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center">
            <div className="inline-flex rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-100 dark:bg-slate-950 p-0.5 text-xs">
              <button
                type="button"
                onClick={() => setViewMode('prism')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer ${
                  viewMode === 'prism'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <GitBranch className="h-3.5 w-3.5" />
                {t('detail.viewPrism')}
              </button>
              <button
                type="button"
                onClick={() => setViewMode('tools')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer ${
                  viewMode === 'tools'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Wrench className="h-3.5 w-3.5" />
                {t('detail.viewTools', { count: trajectoryToolDefs.length })}
              </button>
              <button
                type="button"
                onClick={() => setViewMode('raw')}
                className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium transition-colors cursor-pointer ${
                  viewMode === 'raw'
                    ? 'bg-indigo-600 text-white'
                    : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-200'
                }`}
              >
                <Code2 className="h-3.5 w-3.5" />
                {t('detail.viewRaw')}
              </button>
            </div>
          </div>
        </div>
      </div>

      {viewMode === 'raw' ? (
        <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 overflow-hidden shadow-xs dark:shadow-none">
          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/90 px-4 py-2.5">
            <span className="text-xs font-medium text-slate-700 dark:text-slate-300">
              {t('detail.rawHeader', { version: trajectory.schema_version })}
            </span>
            <CopyButton text={rawAtifJson} label={t('detail.copyJson')} />
          </div>
          <pre className="max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200 bg-slate-50/70 dark:bg-slate-950/80">
            {rawAtifJson}
          </pre>
        </div>
      ) : viewMode === 'tools' ? (
        <ToolDefinitionsPanel
          key={`traj-tools-${selectedSegmentIdx}-${trajectory.trajectory_id || sessionId}`}
          tools={trajectoryToolDefs}
          title={`${t('tools.title')} · ${activeTrajTitle}`}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
          <div className="lg:col-span-5 xl:col-span-5 flex flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 overflow-hidden shadow-xs dark:shadow-none">
            <div className="border-b border-slate-200 dark:border-slate-800 p-3 space-y-2.5 bg-slate-50 dark:bg-slate-900/90">
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400 dark:text-slate-500" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder={t('detail.filterSpansPlaceholder')}
                  className="w-full rounded-lg border border-slate-300 dark:border-slate-700/80 bg-white dark:bg-slate-950 py-1.5 pl-8 pr-3 text-xs text-slate-900 dark:text-slate-100 placeholder-slate-400 dark:placeholder-slate-500 focus:border-indigo-500 focus:outline-none"
                />
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    ['all', t('detail.filterAll')],
                    ['llm_call', t('detail.filterLlm')],
                    ['tool_execution', t('detail.filterTools')],
                    ['event', t('detail.filterUserSys')],
                  ] as const
                ).map(([val, label]) => (
                  <button
                    key={val}
                    type="button"
                    onClick={() => setCategoryFilter(val)}
                    className={`rounded-md px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer ${
                      categoryFilter === val
                        ? 'bg-indigo-50 text-indigo-700 border border-indigo-300 dark:bg-indigo-500/20 dark:text-indigo-300 dark:border-indigo-500/40'
                        : 'bg-white text-slate-600 border border-slate-200 hover:text-slate-900 dark:bg-slate-800/70 dark:text-slate-400 dark:border-slate-700/60 dark:hover:text-slate-200'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="max-h-[68vh] overflow-y-auto">
              {filteredSpans.length === 0 ? (
                <div className="p-8 text-center text-xs text-slate-500">
                  {t('detail.noMatchingSpans')}
                </div>
              ) : (
                filteredSpans.map((span) => (
                  <SpanTreeRow
                    key={span.id}
                    span={span}
                    depth={0}
                    selectedId={selectedSpan?.id ?? null}
                    collapsed={collapsed}
                    minStart={timeRange.minStart}
                    maxEnd={timeRange.maxEnd}
                    onSelect={handleSelectSpan}
                    onToggleCollapse={handleToggleCollapse}
                  />
                ))
              )}
            </div>
          </div>

          <div className="lg:col-span-7 xl:col-span-7 flex flex-col rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/60 overflow-hidden shadow-xs dark:shadow-none">
            {selectedSpan ? (
              <>
                <div className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/90 px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className={`inline-flex shrink-0 items-center rounded border px-2 py-0.5 text-[11px] font-medium ${
                          categoryStyle(selectedSpan.type, selectedSourceStr, t).badge
                        }`}
                      >
                        {categoryStyle(selectedSpan.type, selectedSourceStr, t).label}
                      </span>
                      {selectedSpan.metadata?.isCopiedContext === true && (
                        <span
                          title={t('detail.copiedContextTitle')}
                          className="inline-flex shrink-0 items-center rounded border border-orange-200 dark:border-orange-500/30 bg-orange-50 dark:bg-orange-500/15 px-2 py-0.5 text-[11px] font-medium text-orange-700 dark:text-orange-300"
                        >
                          {t('detail.copiedContext')}
                        </span>
                      )}
                      <h3
                        className="truncate text-sm font-semibold text-slate-900 dark:text-slate-100"
                        title={selectedSpan.title}
                      >
                        {selectedSpan.title}
                      </h3>
                    </div>
                    <div className="flex items-center gap-2 text-xs font-mono text-slate-500 dark:text-slate-400">
                      <span>{formatTimestamp(selectedSpan.startTime.toISOString(), locale)}</span>
                      <span>·</span>
                      <span>{formatPrismDuration(getDurationMs(selectedSpan))}</span>
                    </div>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-1 border-t border-slate-200 dark:border-slate-800/80 pt-2.5">
                    {spanTabs.map(([tab, label]) => (
                      <button
                        key={tab}
                        type="button"
                        onClick={() => setActiveTab(tab)}
                        className={`inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ${
                          activeTab === tab
                            ? 'bg-indigo-600 text-white'
                            : 'text-slate-600 dark:text-slate-400 hover:bg-slate-200/70 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-200'
                        }`}
                      >
                        {tab === 'http' && <Globe className="h-3 w-3" />}
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="max-h-[64vh] overflow-y-auto p-4 space-y-4">
                  {activeTab === 'overview' && selectedSpan.type === 'agent_invocation' && (
                    <AgentOverviewPanel span={selectedSpan} upstreamUrl={upstreamUrl} />
                  )}

                  {activeTab === 'overview' && selectedSpan.type === 'llm_call' && (
                    <>
                      <LlmMetadataStrip
                        span={selectedSpan}
                        upstreamUrl={upstreamUrl}
                        onOpenHttp={
                          selectedRequestRecordId !== undefined
                            ? () => setActiveTab('http')
                            : undefined
                        }
                      />

                      {hasThinkingContent(selectedSpan) && (
                        <div className="rounded-lg border border-fuchsia-200 dark:border-fuchsia-500/30 bg-fuchsia-50/70 dark:bg-fuchsia-950/20 overflow-hidden">
                          <div className="flex items-center justify-between border-b border-fuchsia-200/80 dark:border-fuchsia-500/20 px-3 py-1.5 text-xs text-fuchsia-700 dark:text-fuchsia-300">
                            <span className="inline-flex items-center gap-1.5 font-medium">
                              <Brain className="h-3.5 w-3.5" />
                              {t('detail.reasoning')}
                              {selectedSpan.reasoning?.level && (
                                <span className="rounded bg-fuchsia-200/70 dark:bg-fuchsia-500/20 px-1.5 py-0.5 text-[10px]">
                                  {t('detail.effortLabel', { level: selectedSpan.reasoning.level })}
                                </span>
                              )}
                              {selectedSpan.reasoning?.tokens !== undefined && (
                                <span className="font-mono text-[11px] text-fuchsia-800 dark:text-fuchsia-200">
                                  {t('detail.tokensUnit', {
                                    count: formatNumber(selectedSpan.reasoning.tokens),
                                  })}
                                </span>
                              )}
                            </span>
                            {selectedSpan.reasoning?.content && (
                              <CopyButton text={selectedSpan.reasoning.content} />
                            )}
                          </div>
                          <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-fuchsia-950 dark:text-fuchsia-100/90 max-h-80 overflow-auto">
                            {selectedSpan.reasoning?.content || t('detail.reasoningWithheld')}
                          </pre>
                        </div>
                      )}

                      {selectedSpan.output !== undefined && selectedSpan.output !== '' && (
                        <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 overflow-hidden">
                          <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                            <span className="font-medium text-slate-700 dark:text-slate-300">
                              {t('detail.agentResponse')}
                            </span>
                            <CopyButton text={selectedSpan.output} />
                          </div>
                          <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200 max-h-96 overflow-auto">
                            {selectedSpan.output}
                          </pre>
                        </div>
                      )}

                      {selectedSpan.children &&
                        selectedSpan.children.some((c) => c.type === 'tool_execution') && (
                          <div className="rounded-lg border border-amber-200 dark:border-amber-500/25 bg-slate-50 dark:bg-slate-950/80 overflow-hidden">
                            <div className="flex items-center justify-between border-b border-amber-200/70 dark:border-slate-800 px-3 py-1.5 text-xs text-amber-800 dark:text-amber-300 bg-amber-50/60 dark:bg-transparent">
                              <span className="inline-flex items-center gap-1.5 font-medium">
                                <Wrench className="h-3.5 w-3.5" />
                                {t('detail.toolCalls', {
                                  count: selectedSpan.children.filter((c) => c.type === 'tool_execution')
                                    .length,
                                })}
                              </span>
                            </div>
                            <div className="divide-y divide-slate-200 dark:divide-slate-800/70">
                              {selectedSpan.children
                                .filter((c) => c.type === 'tool_execution')
                                .map((tc) => (
                                  <div key={tc.id} className="p-3 space-y-1.5">
                                    <div className="flex items-center justify-between gap-2">
                                      <button
                                        type="button"
                                        onClick={() => handleSelectSpan(tc)}
                                        className="inline-flex flex-wrap items-center gap-1.5 font-mono text-xs font-medium text-amber-700 hover:text-amber-800 dark:text-amber-300 dark:hover:text-amber-200 cursor-pointer text-left"
                                      >
                                        <span>
                                          {typeof tc.metadata?.functionName === 'string'
                                            ? tc.metadata.functionName
                                            : tc.title}
                                        </span>
                                        {typeof tc.metadata?.toolCallId === 'string' && (
                                          <span className="text-[10px] text-slate-500">
                                            ({tc.metadata.toolCallId})
                                          </span>
                                        )}
                                      </button>
                                      {tc.input && <CopyButton text={tc.input} label={t('detail.copyArgs')} />}
                                    </div>
                                    {tc.input && (
                                      <pre className="whitespace-pre-wrap break-words rounded border border-slate-200 dark:border-slate-800/80 bg-white dark:bg-slate-950 p-2 font-mono text-[11px] leading-relaxed text-slate-700 dark:text-slate-300 max-h-48 overflow-auto">
                                        {tc.input}
                                      </pre>
                                    )}
                                  </div>
                                ))}
                            </div>
                          </div>
                        )}
                    </>
                  )}

                  {activeTab === 'overview' &&
                    selectedSpan.type !== 'agent_invocation' &&
                    selectedSpan.type !== 'llm_call' && (
                      <>
                        {selectedSpan.type === 'tool_execution' && (
                          <ToolMetadataStrip span={selectedSpan} />
                        )}

                        {selectedSpan.input !== undefined && selectedSpan.input !== '' && (
                          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 overflow-hidden">
                            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                              <span className="font-medium text-slate-700 dark:text-slate-300">
                                {selectedSpan.type === 'tool_execution'
                                  ? t('detail.toolArguments')
                                  : selectedSpan.metadata?.source === 'system'
                                    ? t('detail.systemPrompt')
                                    : selectedSpan.metadata?.source === 'user'
                                      ? t('detail.userMessage')
                                      : t('detail.input')}
                              </span>
                              <CopyButton text={selectedSpan.input} />
                            </div>
                            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200 max-h-96 overflow-auto">
                              {selectedSpan.input}
                            </pre>
                          </div>
                        )}

                        {selectedSpan.output !== undefined && selectedSpan.output !== '' && (
                          <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 overflow-hidden">
                            <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                              <span className="font-medium text-slate-700 dark:text-slate-300">
                                {selectedSpan.type === 'tool_execution'
                                  ? t('detail.toolObservation')
                                  : t('detail.agentResponse')}
                              </span>
                              <CopyButton text={selectedSpan.output} />
                            </div>
                            <pre className="whitespace-pre-wrap break-words p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200 max-h-96 overflow-auto">
                              {selectedSpan.output}
                            </pre>
                          </div>
                        )}

                        {(!selectedSpan.input || selectedSpan.input === '') &&
                          (!selectedSpan.output || selectedSpan.output === '') && (
                            <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/60 p-6 text-center text-xs text-slate-500">
                              {t('detail.noIo')}
                            </div>
                          )}
                      </>
                    )}

                  {activeTab === 'http' && selectedRequestRecordId !== undefined && (
                    <HttpInspectorPanel
                      requestId={selectedRequestRecordId}
                      cache={httpCacheRef.current}
                      onUnauthorized={onUnauthorized}
                    />
                  )}

                  {activeTab === 'tools' && (
                    <ToolDefinitionsPanel
                      key={`span-tools-${selectedSpan.id}`}
                      tools={selectedSpanToolDefs}
                      title={`${t('tools.title')} · ${selectedSpan.title}`}
                      compact
                    />
                  )}

                  {activeTab === 'attributes' && (
                    <div className="overflow-hidden rounded-lg border border-slate-200 dark:border-slate-800">
                      {!selectedSpan.attributes || selectedSpan.attributes.length === 0 ? (
                        <div className="bg-slate-50 dark:bg-slate-950/60 p-6 text-center text-xs text-slate-500">
                          {t('detail.noAttributes')}
                        </div>
                      ) : (
                        <table className="w-full text-left text-xs">
                          <thead className="border-b border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 text-slate-500 dark:text-slate-400">
                            <tr>
                              <th className="px-3 py-2 font-medium">{t('detail.colKey')}</th>
                              <th className="px-3 py-2 font-medium">{t('detail.colValue')}</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-200 dark:divide-slate-800/70 bg-white dark:bg-slate-950/50 font-mono">
                            {selectedSpan.attributes.map((attr) => {
                              const plain = toPlainAttributeValue(attr.value);
                              const display =
                                typeof plain === 'object' && plain !== null
                                  ? JSON.stringify(plain)
                                  : String(plain ?? '');
                              return (
                                <tr key={attr.key}>
                                  <td className="px-3 py-2 text-slate-500 dark:text-slate-400 whitespace-nowrap">
                                    {attr.key}
                                  </td>
                                  <td className="px-3 py-2 text-slate-800 dark:text-slate-200 break-all">
                                    {display}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>
                  )}

                  {activeTab === 'raw' && (
                    <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950/80 overflow-hidden">
                      <div className="flex items-center justify-between border-b border-slate-200 dark:border-slate-800 px-3 py-1.5 text-xs text-slate-500 dark:text-slate-400">
                        <span>{t('detail.rawSpanJson')}</span>
                        <CopyButton text={selectedSpan.raw.join('\n')} />
                      </div>
                      <pre className="overflow-auto p-3 font-mono text-xs leading-relaxed text-slate-800 dark:text-slate-200">
                        {selectedSpan.raw.join('\n')}
                      </pre>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="p-12 text-center text-xs text-slate-500">
                {t('detail.selectSpanHint')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
