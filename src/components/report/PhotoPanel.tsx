import { Camera, Images, Loader2, X } from 'lucide-react'
import { useEffect, useRef } from 'react'
import { useI18n } from '../../lib/i18n'
import type { PhotoDraft } from './usePhotoDraft'

/** Camera / gallery picker with up to 3 compressed previews. `autoOpen` tries to open the camera once. */
export function PhotoPanel({ draft, autoOpen, onAutoOpened }: {
  draft: PhotoDraft; autoOpen?: boolean; onAutoOpened?: () => void
}) {
  const { t } = useI18n()
  const camera = useRef<HTMLInputElement>(null)
  const gallery = useRef<HTMLInputElement>(null)
  const autoOpened = useRef(false)
  const { photos, busy, error, max } = draft
  const full = photos.length + busy >= max

  // Opened from the map's camera button: jump straight to the camera (best effort — browsers may require
  // a fresh tap, in which case the big button below is right there).
  useEffect(() => {
    if (!autoOpen || autoOpened.current) return
    autoOpened.current = true
    onAutoOpened?.()
    try { camera.current?.click() } catch { /* blocked without user activation */ }
  }, [autoOpen, onAutoOpened])

  const onFiles = (input: HTMLInputElement) => {
    const files = input.files ? Array.from(input.files) : []
    input.value = '' // allow picking the same file again after removing it
    void draft.add(files)
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        <button
          type="button"
          disabled={full}
          onClick={() => camera.current?.click()}
          className="inline-flex min-h-16 flex-1 items-center justify-center gap-3 rounded-2xl bg-brand-700 px-4 text-lg font-bold text-white shadow-md active:scale-[0.98] disabled:opacity-50"
        >
          <Camera className="size-8" /> {t('report.takePhoto')}
        </button>
        <button
          type="button"
          disabled={full}
          onClick={() => gallery.current?.click()}
          aria-label={t('report.fromGallery')}
          className="inline-flex min-h-16 w-20 flex-col items-center justify-center gap-0.5 rounded-2xl border border-slate-200 bg-white text-xs font-semibold text-ink shadow-sm active:scale-[0.98] disabled:opacity-50"
        >
          <Images className="size-7" /> {t('report.fromGallery')}
        </button>
      </div>
      <input ref={camera} type="file" accept="image/*" capture="environment" multiple className="hidden"
        onChange={(e) => onFiles(e.currentTarget)} />
      <input ref={gallery} type="file" accept="image/*" multiple className="hidden"
        onChange={(e) => onFiles(e.currentTarget)} />

      {(photos.length > 0 || busy > 0) && (
        <div className="grid grid-cols-3 gap-2">
          {photos.map((p, i) => (
            <div key={p.id} className="relative aspect-square overflow-hidden rounded-2xl bg-slate-100">
              <img src={p.url} alt="" className="size-full object-cover" decoding="async" />
              <span className="font-latin absolute bottom-1 start-1 rounded-full bg-black/50 px-2 text-xs font-bold text-white">{i + 1}</span>
              <button
                type="button"
                onClick={() => draft.remove(p.id)}
                aria-label={t('report.removePhoto')}
                title={t('report.removePhoto')}
                className="absolute end-1 top-1 inline-flex size-11 items-center justify-center rounded-full bg-black/60 text-white active:scale-95"
              >
                <X className="size-6" />
              </button>
            </div>
          ))}
          {Array.from({ length: busy }, (_, i) => (
            <div key={`busy-${i}`} className="flex aspect-square flex-col items-center justify-center gap-1 rounded-2xl bg-slate-100 text-slate-500">
              <Loader2 className="size-7 animate-spin" />
              <span className="px-1 text-center text-[11px] leading-tight">{t('report.preparingPhoto')}</span>
            </div>
          ))}
        </div>
      )}

      <p className="text-center text-sm text-slate-500">
        {photos.length > 0 ? t('report.photoCount', { n: photos.length, max }) : t('report.photoMax', { max })}
      </p>
      {error && (
        <p role="alert" className="rounded-2xl bg-amber-50 px-3 py-2 text-center text-sm font-medium text-amber-800">
          {error === 'too_large' ? t('report.photoTooLarge') : t('report.photoDecodeError')}
        </p>
      )}
    </div>
  )
}
