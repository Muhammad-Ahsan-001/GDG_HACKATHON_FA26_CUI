// Read-aloud button for users who cannot read: speaks `text` via the tts Edge Function (cached server-side).
import clsx from 'clsx'
import { Loader2, Square, Volume2 } from 'lucide-react'
import { useEffect, useRef, useState, type MouseEvent } from 'react'
import { api } from '../../lib/api'
import { useI18n } from '../../lib/i18n'
import type { Lang } from '../../lib/types'

const urlCache = new Map<string, string>()
let current: HTMLAudioElement | null = null

export function ListenButton({ text, lang, className }: { text: string; lang?: Lang; className?: string }) {
  const { t, lang: uiLang } = useI18n()
  const [state, setState] = useState<'idle' | 'loading' | 'playing' | 'error'>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const speakLang = lang ?? uiLang

  useEffect(() => () => { audioRef.current?.pause() }, [])

  async function onClick(e: MouseEvent) {
    e.stopPropagation()
    e.preventDefault()
    if (state === 'playing') { audioRef.current?.pause(); setState('idle'); return }
    if (!text.trim()) return
    setState('loading')
    try {
      const key = `${speakLang}|${text}`
      let url = urlCache.get(key)
      if (!url) {
        url = (await api.tts(text.slice(0, 600), speakLang)).url
        urlCache.set(key, url)
      }
      current?.pause()
      const audio = new Audio(url)
      current = audio
      audioRef.current = audio
      audio.onended = () => setState('idle')
      audio.onpause = () => setState((s) => (s === 'playing' ? 'idle' : s))
      await audio.play()
      setState('playing')
    } catch {
      setState('error')
      setTimeout(() => setState('idle'), 2500)
    }
  }

  const label = state === 'playing' ? t('auth.stopAudio') : t('common.listen')
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={clsx(
        'inline-flex size-12 shrink-0 items-center justify-center rounded-full transition active:scale-95',
        state === 'error' ? 'bg-red-100 text-red-700' : state === 'playing' ? 'bg-brand-700 text-white' : 'bg-brand-50 text-brand-700 hover:bg-brand-100',
        className,
      )}
    >
      {state === 'loading' ? <Loader2 className="size-6 animate-spin" /> : state === 'playing' ? <Square className="size-5" /> : <Volume2 className="size-6" />}
    </button>
  )
}
