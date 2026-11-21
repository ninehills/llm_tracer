export function formatNumber(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '0';
  return n.toLocaleString();
}

export function formatTokensCompact(n: number | undefined | null): string {
  if (n === undefined || n === null || Number.isNaN(n)) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export function formatCacheHitRate(
  cached: number | undefined | null,
  prompt: number | undefined | null
): string {
  const c = typeof cached === 'number' && !Number.isNaN(cached) && cached > 0 ? cached : 0;
  const p = typeof prompt === 'number' && !Number.isNaN(prompt) && prompt > 0 ? prompt : 0;
  const pct = p > 0 ? Math.min(100, (c / p) * 100) : 0;
  return `${pct.toFixed(1)}%`;
}

export function formatTimestamp(ts: string | undefined | null, locale?: string): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString(locale, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function formatCompactTimestamp(ts: string | number | undefined | null): string {
  if (ts === undefined || ts === null || ts === '') return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return typeof ts === 'string' ? ts : '—';
  return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function formatFullTimestamp(ts: string | number | undefined | null, locale?: string): string {
  if (ts === undefined || ts === null || ts === '') return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return typeof ts === 'string' ? ts : '—';
  return d.toLocaleString(locale, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || Number.isNaN(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(2)}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}m ${rem.toFixed(1)}s`;
}

export function shortApiKeyHash(hash: string | undefined | null, length = 6): string {
  if (!hash) return '';
  return hash.slice(0, length);
}

export function harnessBadgeColor(harness: string): string {
  const h = (harness || '').toLowerCase();
  if (h.includes('pi')) {
    return 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-300 dark:border-violet-500/30';
  }
  if (h.includes('claude')) {
    return 'bg-amber-50 text-amber-800 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30';
  }
  if (h.includes('codex') || h.includes('openai')) {
    return 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30';
  }
  if (h.includes('cursor')) {
    return 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-300 dark:border-sky-500/30';
  }
  if (h.includes('opencode') || h.includes('aider')) {
    return 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-500/15 dark:text-pink-300 dark:border-pink-500/30';
  }
  return 'bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-700/60 dark:text-slate-300 dark:border-slate-600/50';
}
