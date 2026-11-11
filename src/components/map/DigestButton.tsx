import clsx from 'clsx'
import { Ear, Sparkles } from 'lucide-react'
import { memo, useMemo } from 'react'
import { distanceM } from '../../hooks/useGeolocation'
import { URGENCY_META } from '../../lib/categories'
import { useI18n } from '../../lib/i18n'
import type { MapPin } from '../../lib/types'
import { playUrl } from '../../lib/voice/player'

/**
 * Floating "Near me" digest button for the citizen map (amber, ear + sparkles, red badge = urgent problems nearby).
 * Kept apart from DigestSheet.tsx so the sheet (AI digest, voice, lists) is code-split and only loads on tap.
 */

export const DIGEST_RADIUS_M = 3000
/** 8 ms of silence: played inside the tap so iOS lets the digest audio start after the network call. */
const SILENT_WAV = 'data:audio/wav;base64,UklGRmQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YUAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICA'

type LatLng = { lat: number; lng: number }

/** Unlock the shared audio element during the user's tap (iOS); harmless elsewhere. */
export function primeDigestAudio(): void {
  void playUrl(SILENT_WAV, 'digest:prime')
}

export const isActivePin = (p: MapPin) => p.status !== 'resolved'

export const DigestButton = memo(function DigestButton({
  onOpen, pins, center, className,
}: { onOpen: () => void; pins: readonly MapPin[]; center: LatLng; className?: string }) {
  const { t } = useI18n()
  const urgent = useMemo(() => {
    let n = 0
    for (const p of pins) {
      if (!isActivePin(p) || p.status === 'disputed' || (URGENCY_META[p.urgency]?.rank ?? 0) < 2) continue
      if (distanceM(center, p) <= DIGEST_RADIUS_M) n++
    }
    return n
  }, [pins, center])
  const aria = urgent > 0 ? `${t('map.digestAria')} · ${t('map.digestUrgentBadge', { n: urgent })}` : t('map.digestAria')

  return (
    <div className={clsx('flex flex-col items-center gap-1', className)}>
      <button
        type="button"
        data-awaaz-coach-keep=""
        onClick={() => { primeDigestAudio(); onOpen() }}
        aria-label={aria}
        title={aria}
        className="relative inline-flex size-[60px] items-center justify-center rounded-full text-amber-950 shadow-lg ring-4 ring-white transition active:scale-95"
        style={{ background: 'linear-gradient(140deg, #FDE68A 0%, #FBBF24 45%, #F59E0B 100%)' }}
      >
        <Ear className="size-8" strokeWidth={2.4} />
        <span aria-hidden className="absolute -top-1.5 -end-1.5 inline-flex size-7 items-center justify-center rounded-full bg-white text-amber-500 shadow">
          <Sparkles className="size-4" strokeWidth={2.6} />
        </span>
        {urgent > 0 && (
          <span
            aria-hidden
            className="font-latin absolute -bottom-1 -end-1.5 inline-flex h-6 min-w-6 items-center justify-center rounded-full px-1 text-xs font-black text-white ring-2 ring-white"
            style={{ background: URGENCY_META.critical.color }}
          >
            {urgent > 9 ? '9+' : urgent}
          </span>
        )}
      </button>
      <span aria-hidden className="max-w-[5.5rem] truncate rounded-full bg-white/95 px-2 text-xs font-bold text-ink shadow-sm">
        {t('map.digestButton')}
      </span>
    </div>
  )
})
