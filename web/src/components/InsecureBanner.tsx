import { AlertTriangle } from 'lucide-react';
import { useI18n } from '../utils/i18n';

export function InsecureBanner() {
  const { t } = useI18n();

  return (
    <div
      role="alert"
      className="sticky top-0 z-50 border-b border-amber-300 dark:border-amber-500/40 bg-amber-50/95 dark:bg-amber-950/95 px-4 py-2.5 text-amber-900 dark:text-amber-200 backdrop-blur"
    >
      <div className="mx-auto flex max-w-[1600px] items-center justify-center gap-2.5 text-xs sm:text-sm font-medium">
        <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span>
          {t('banner.prefix')}{' '}
          <code className="rounded bg-amber-200/70 dark:bg-amber-900/80 px-1.5 py-0.5 font-mono text-amber-950 dark:text-amber-100">
            dashboard_key
          </code>{' '}
          {t('banner.suffix')}
        </span>
      </div>
    </div>
  );
}
