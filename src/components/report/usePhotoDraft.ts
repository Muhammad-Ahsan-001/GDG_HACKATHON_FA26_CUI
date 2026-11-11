import { useCallback, useEffect, useRef, useState } from 'react'
import { compressImage, MAX_PHOTOS, MediaUploadError, newClientId, type MediaErrorCode } from '../../lib/media'

export interface DraftPhoto { id: string; blob: Blob; url: string; width: number; height: number }

/** Photos attached to the report draft: compressed on add, object URLs revoked on remove / clear / unmount. */
export function usePhotoDraft(max = MAX_PHOTOS) {
  const [photos, setPhotos] = useState<DraftPhoto[]>([])
  const [busy, setBusy] = useState(0)
  const [error, setError] = useState<MediaErrorCode | null>(null)
  const photosRef = useRef<DraftPhoto[]>([])
  const pending = useRef(0)
  const mounted = useRef(true)

  useEffect(() => { photosRef.current = photos }, [photos])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      photosRef.current.forEach((p) => URL.revokeObjectURL(p.url))
      photosRef.current = []
    }
  }, [])

  const add = useCallback(async (files: FileList | File[] | null) => {
    if (!files || files.length === 0) return
    setError(null)
    const free = Math.max(0, max - photosRef.current.length - pending.current)
    const list = Array.from(files).filter((f) => !f.type || f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name)).slice(0, free)
    if (list.length === 0) return
    pending.current += list.length
    setBusy(pending.current)
    // sequential: decoding several 12 MP photos at once can exhaust memory on cheap phones
    for (const file of list) {
      try {
        const { blob, width, height } = await compressImage(file)
        if (!mounted.current) return
        const photo: DraftPhoto = { id: newClientId(), blob, url: URL.createObjectURL(blob), width, height }
        setPhotos((prev) => {
          const next = prev.length >= max ? prev : [...prev, photo]
          if (next === prev) URL.revokeObjectURL(photo.url)
          photosRef.current = next
          return next
        })
      } catch (e) {
        if (!mounted.current) return
        setError(e instanceof MediaUploadError ? e.code : 'decode')
      } finally {
        pending.current -= 1
        if (mounted.current) setBusy(pending.current)
      }
    }
  }, [max])

  const remove = useCallback((id: string) => {
    setPhotos((prev) => {
      const hit = prev.find((p) => p.id === id)
      if (hit) URL.revokeObjectURL(hit.url)
      const next = prev.filter((p) => p.id !== id)
      photosRef.current = next
      return next
    })
    setError(null)
  }, [])

  const clear = useCallback(() => {
    photosRef.current.forEach((p) => URL.revokeObjectURL(p.url))
    photosRef.current = []
    setPhotos([])
    setError(null)
  }, [])

  return { photos, busy, error, add, remove, clear, max }
}

export type PhotoDraft = ReturnType<typeof usePhotoDraft>
