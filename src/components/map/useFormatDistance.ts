import { useCallback } from 'react'
import { useI18n } from '../../lib/i18n'

/** "350 m" / "1.2 km" in the current language. */
export function useFormatDistance() {
  const { t } = useI18n()
  return useCallback(
    (m: number) => (m < 1000
      ? t('common.m', { n: Math.max(10, Math.round(m / 10) * 10) })
      : t('common.km', { n: (m / 1000).toFixed(m < 10000 ? 1 : 0) })),
    [t],
  )
}
