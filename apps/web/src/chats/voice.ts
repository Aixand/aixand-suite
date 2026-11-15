import { useEffect, useRef, useState } from 'react'
import type { AgentsModel } from '../agents/model'
import { requestId } from '../terminals/connection'

type Phase = 'idle' | 'permission' | 'connecting' | 'active' | 'stopping' | 'stop-failed'
type Caption = { id: string; role: 'user' | 'assistant'; text: string; done: boolean }
type VoiceEvent =
  | { kind: 'sdp'; sdp: string }
  | { kind: 'transcript'; role: Caption['role']; text: string; done: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'closed'; reason?: string }
type Session = {
  key: string
  chatId: string | null
  cancelled: boolean
  requested: boolean
  answered: boolean
  stream?: MediaStream
  peer?: RTCPeerConnection
  audio?: HTMLAudioElement
  deadline?: ReturnType<typeof setTimeout>
  stopping?: Promise<void>
}

async function gatherIce(peer: RTCPeerConnection) {
  if (peer.iceGatheringState === 'complete') return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Could not prepare the voice connection. Try again.')), 10000)
    const check = () => { if (peer.iceGatheringState === 'complete') finish() }
    const finish = (error?: Error) => {
      clearTimeout(timer)
      peer.removeEventListener('icegatheringstatechange', check)
      if (error) reject(error)
      else resolve()
    }
    peer.addEventListener('icegatheringstatechange', check)
    check()
  })
}

function releaseMedia(session: Session) {
  clearTimeout(session.deadline)
  for (const track of session.stream?.getTracks() ?? []) track.stop()
  if (session.peer) {
    session.peer.ontrack = null
    session.peer.onconnectionstatechange = null
    session.peer.close()
  }
  if (session.audio) {
    session.audio.pause()
    session.audio.srcObject = null
  }
}

function microphoneError(error: unknown) {
  if (error instanceof DOMException) {
    if (error.name === 'NotAllowedError') return 'Microphone access was denied. Allow it in your browser’s site settings and try again.'
    if (error.name === 'NotFoundError') return 'No microphone was found. Connect a microphone and try again.'
    if (error.name === 'NotReadableError') return 'Your microphone is unavailable. Check whether another app is using it.'
  }
  return error instanceof Error ? error.message : 'Voice could not connect. Try again.'
}

export function useVoice(agents: AgentsModel, chatId: string | null) {
  const api = useRef(agents)
  api.current = agents
  const session = useRef<Session | null>(null)
  const previousChat = useRef(chatId)
  const mounted = useRef(true)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [muted, setMuted] = useState(false)
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const [captions, setCaptions] = useState<Caption[]>([])
  const unavailable = !window.isSecureContext ? 'Microphone access needs HTTPS or localhost.' :
    !navigator.mediaDevices?.getUserMedia || typeof RTCPeerConnection === 'undefined' ? 'This browser does not support voice chat.' : ''

  async function stop(reason = '', remotelyClosed = false) {
    const live = session.current
    if (!live) return
    live.cancelled = true
    releaseMedia(live)
    if (reason && mounted.current) setError(reason)
    if (remotelyClosed) {
      session.current = null
      if (mounted.current) { setPhase('idle'); setPlaybackBlocked(false) }
      return
    }
    if (live.stopping) return live.stopping
    if (mounted.current) setPhase('stopping')
    const task = (async () => {
      try {
        if (live.requested && live.chatId)
          await api.current.request('chat-voice-stop', { key: live.key, chatId: live.chatId })
        if (session.current === live) {
          session.current = null
          if (mounted.current) { setPhase('idle'); setPlaybackBlocked(false) }
        }
      } catch (cause) {
        if (session.current === live && mounted.current) {
          setPhase('stop-failed')
          setError(`${reason ? `${reason} ` : ''}Microphone is off. Voice stop is unconfirmed: ${microphoneError(cause)}`)
        }
      } finally { live.stopping = undefined }
    })()
    live.stopping = task
    await task
  }

  async function start(resolveChat: () => Promise<string>, onChatReady: (id: string) => void) {
    if (session.current) return
    setError('')
    if (unavailable) { setError(unavailable); return }
    const live: Session = { key: requestId(), chatId, cancelled: false, requested: false, answered: false }
    session.current = live
    const current = () => session.current === live && !live.cancelled
    setPhase('permission'); setMuted(false); setPlaybackBlocked(false); setCaptions([])
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: {
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      }, video: false })
      if (!current()) { stream.getTracks().forEach((track) => track.stop()); return }
      live.stream = stream
      for (const track of stream.getAudioTracks()) {
        track.enabled = false
        track.addEventListener('ended', () => { if (current()) void stop('Microphone access ended.') }, { once: true })
      }
      setPhase('connecting')
      const id = await resolveChat()
      if (!current()) return
      live.chatId = id
      onChatReady(id)
      const peer = new RTCPeerConnection()
      const audio = new Audio()
      audio.autoplay = true
      live.peer = peer; live.audio = audio
      peer.ontrack = (event) => {
        if (!current()) return
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
        void audio.play().catch(() => { if (current()) setPlaybackBlocked(true) })
      }
      peer.onconnectionstatechange = () => {
        if (!current()) return
        if (peer.connectionState === 'connected') {
          clearTimeout(live.deadline)
          stream.getAudioTracks().forEach((track) => { track.enabled = true })
          setPhase('active')
        } else if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
          void stop('Voice connection lost. Start voice again to reconnect.')
        }
      }
      for (const track of stream.getAudioTracks()) peer.addTrack(track, stream)
      peer.createDataChannel('oai-events')
      await peer.setLocalDescription(await peer.createOffer())
      await gatherIce(peer)
      if (!current()) return
      const sdp = peer.localDescription?.sdp
      if (!sdp) throw new Error('Could not prepare the voice connection.')
      live.requested = true
      live.deadline = setTimeout(() => { if (current()) void stop('Voice did not connect. Check your connection and try again.') }, 45000)
      await api.current.request('chat-voice-start', { key: live.key, chatId: id, sdp })
    } catch (cause) {
      if (current()) await stop(microphoneError(cause))
    }
  }

  const actions = useRef({ stop })
  actions.current = { stop }
  useEffect(() => api.current.subscribe((value) => {
    const message = value as { type: string; chatId?: string; key?: string; event?: VoiceEvent | { kind: 'connection' } }
    const live = session.current
    if (!live) return
    if (message.type === 'chat-event' && message.event?.kind === 'connection') {
      void actions.current.stop('Voice connection lost.', true)
      return
    }
    if (message.type !== 'chat-voice-event' || message.chatId !== live.chatId || message.key !== live.key) return
    const event = message.event as VoiceEvent
    if (event.kind === 'closed') {
      void actions.current.stop(live.cancelled ? '' : event.reason ?? 'Voice ended.', true)
    } else if (!live.cancelled && event.kind === 'error') {
      void actions.current.stop(event.message)
    } else if (!live.cancelled && event.kind === 'sdp' && live.peer && !live.answered) {
      live.answered = true
      void live.peer.setRemoteDescription({ type: 'answer', sdp: event.sdp }).catch((cause) => {
        if (session.current === live && !live.cancelled) void actions.current.stop(microphoneError(cause))
      })
    } else if (!live.cancelled && event.kind === 'transcript') {
      setCaptions((previous) => {
        const last = [...previous].reverse().find((caption) => caption.role === event.role && !caption.done)
        const text = (event.done ? event.text : `${last?.text ?? ''}${event.text}`).slice(-8192)
        const caption = { id: last?.id ?? requestId(), role: event.role, text, done: event.done }
        return (last ? previous.map((item) => item.id === caption.id ? caption : item) : [...previous, caption]).slice(-6)
      })
    }
  }), [])
  useEffect(() => {
    const live = session.current
    if (previousChat.current !== chatId && (!live || chatId !== live.chatId)) {
      setCaptions([]); setError('')
    }
    previousChat.current = chatId
    if (live && (chatId !== live.chatId || agents.status !== 'connected'))
      void actions.current.stop(agents.status !== 'connected' ? 'Voice connection lost. Your microphone is off.' : '')
  }, [chatId, agents.status])
  useEffect(() => {
    mounted.current = true
    const hide = () => { void actions.current.stop() }
    window.addEventListener('pagehide', hide)
    return () => {
      mounted.current = false
      window.removeEventListener('pagehide', hide)
      void actions.current.stop()
    }
  }, [])

  function toggleMute() {
    if (phase !== 'active') return
    const next = !muted
    session.current?.stream?.getAudioTracks().forEach((track) => { track.enabled = !next })
    setMuted(next)
  }
  async function play() {
    try { await session.current?.audio?.play(); setPlaybackBlocked(false) }
    catch { setError('Audio playback is blocked. Allow sound in your browser’s site settings.') }
  }
  return { phase, error, muted, playbackBlocked, captions, unavailable, start, stop, toggleMute, play,
    engaged: phase !== 'idle' }
}
export type VoiceModel = ReturnType<typeof useVoice>
