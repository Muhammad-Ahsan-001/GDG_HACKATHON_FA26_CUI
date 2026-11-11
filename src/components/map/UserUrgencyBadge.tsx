import clsx from 'clsx'
import { USER_URGENCY_META, type UserUrgency } from '../../lib/attributes'
import { useI18n } from '../../lib/i18n'

/**
 * What the REPORTER said about urgency (Emergency / Urgent / Can wait) — distinct from the AI urgency badge.
 * Icon + colour first; renders nothing when the reporter did not say.
 */
export function UserUrgencyBadge({ value, size = 'md', className }: {
  value: UserUrgency | null | undefined
  size?: 'sm' | 'md'
  className?: string
}) {
  const { t, lang } = useI18n()
  const m = value ? USER_URGENCY_META[value] : null
  if (!m) return null
  const Icon = m.icon
  const label = lang === 'ur' ? m.ur : m.en
  return (
    <span
      title={t('map.userUrgency', { u: label })}
      aria-label={t('map.userUrgency', { u: label })}
      className={clsx(
        'inline-flex shrink-0 items-center gap-1 rounded-full font-bold ring-1',
        size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-2.5 py-1 text-sm',
        className,
      )}
      style={{ background: m.soft, color: m.color, ['--tw-ring-color' as string]: `${m.color}55` }}
    >
      <Icon className={size === 'sm' ? 'size-3.5' : 'size-4'} strokeWidth={2.5} />
      {label}
    </span>
  )
}
