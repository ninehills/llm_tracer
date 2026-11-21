import { Moon, Sun } from 'lucide-react';
import { useTheme } from '../utils/theme';
import { useI18n } from '../utils/i18n';

export function HeaderControls() {
  const { theme, toggleTheme } = useTheme();
  const { lang, toggleLang, t } = useI18n();

  return (
    <div className="inline-flex items-center gap-1.5">
      <button
        type="button"
        onClick={toggleLang}
        title={t('controls.switchLang')}
        aria-label={t('controls.switchLang')}
        className="inline-flex h-8 items-center gap-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 px-2.5 text-xs font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
      >
        <span className={lang === 'zh' ? 'text-indigo-600 dark:text-indigo-300 font-semibold' : 'text-slate-400 dark:text-slate-500'}>
          中
        </span>
        <span className="text-slate-300 dark:text-slate-600">/</span>
        <span className={lang === 'en' ? 'text-indigo-600 dark:text-indigo-300 font-semibold' : 'text-slate-400 dark:text-slate-500'}>
          EN
        </span>
      </button>

      <button
        type="button"
        onClick={toggleTheme}
        title={theme === 'dark' ? t('controls.switchToLight') : t('controls.switchToDark')}
        aria-label={theme === 'dark' ? t('controls.switchToLight') : t('controls.switchToDark')}
        className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800/80 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors cursor-pointer"
      >
        {theme === 'dark' ? (
          <Sun className="h-4 w-4 text-amber-400" />
        ) : (
          <Moon className="h-4 w-4 text-indigo-600" />
        )}
      </button>
    </div>
  );
}
