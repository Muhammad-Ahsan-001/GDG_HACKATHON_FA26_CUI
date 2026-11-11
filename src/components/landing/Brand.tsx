import clsx from 'clsx'
import { useI18n } from '../../lib/i18n'
import type { Lang } from '../../lib/types'

const LANG_LABEL: Record<Lang, string> = { ur: 'اردو', en: 'English' }

export function Logo({ className }: { className?: string }) {
  const { t } = useI18n()
  return (
    <span className={clsx('inline-flex items-center gap-2', className)}>
      <span aria-hidden className="font-urdu relative inline-flex size-10 items-center justify-center rounded-2xl bg-linear-to-br from-teal-300 to-brand-700 text-xl font-bold leading-none text-white shadow-lg shadow-teal-500/30">
        آ
        <span className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-amber-400 ring-2 ring-white" />
      </span>
      <span className="font-latin text-lg font-black tracking-tight text-slate-800">Awaaz</span>
      <span className="sr-only">{t('landing.brand')}</span>
    </span>
  )
}

/** Both scripts always visible, so anyone can find their own language. Glassy white pill for the light sky. */
export function LangToggle({ className }: { className?: string }) {
  const { lang, toggleLang, t } = useI18n()
  return (
    <div role="radiogroup" aria-label={t('landing.langLabel')}
      className={clsx('flex rounded-full bg-white/80 p-1 shadow-sm ring-1 ring-slate-200 backdrop-blur', className)}>
      {(['ur', 'en'] as const).map((l) => (
        <button key={l} type="button" role="radio" aria-checked={lang === l} lang={l}
          onClick={() => { if (lang !== l) toggleLang() }}
          className={clsx(
            'min-h-10 rounded-full px-3.5 text-sm font-bold transition',
            l === 'ur' ? 'font-urdu leading-none' : 'font-latin',
            lang === l
              ? 'bg-brand-700 text-white shadow shadow-teal-900/20'
              : 'text-slate-600 hover:bg-brand-50 hover:text-brand-700',
          )}>
          {LANG_LABEL[l]}
        </button>
      ))}
    </div>
  )
}
