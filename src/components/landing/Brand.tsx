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
        <span className="absolute -end-0.5 -top-0.5 size-2.5 rounded-full bg-amber-400 ring-2 ring-[#071631]" />
      </span>
      <span className="font-latin text-lg font-black tracking-tight">Awaaz</span>
      <span className="sr-only">{t('landing.brand')}</span>
    </span>
  )
}

/** Both scripts always visible, so anyone can find their own language. */
export function LangToggle({ dark = true, className }: { dark?: boolean; className?: string }) {
  const { lang, toggleLang, t } = useI18n()
  return (
    <div role="radiogroup" aria-label={t('landing.langLabel')}
      className={clsx('flex rounded-full p-1', dark ? 'bg-white/10 ring-1 ring-white/15' : 'bg-slate-100 ring-1 ring-slate-200', className)}>
      {(['ur', 'en'] as const).map((l) => (
        <button key={l} type="button" role="radio" aria-checked={lang === l} lang={l}
          onClick={() => { if (lang !== l) toggleLang() }}
          className={clsx(
            'min-h-10 rounded-full px-3.5 text-sm font-bold transition',
            l === 'ur' ? 'font-urdu leading-none' : 'font-latin',
            lang === l
              ? (dark ? 'bg-white text-[#071631] shadow' : 'bg-white text-ink shadow')
              : (dark ? 'text-white/80 hover:bg-white/10' : 'text-slate-600 hover:bg-white'),
          )}>
          {LANG_LABEL[l]}
        </button>
      ))}
    </div>
  )
}
