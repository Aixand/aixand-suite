import { useEffect, useRef, useState } from 'react'
import { sessionSocket } from '../auth/client'
import { requestId } from '../terminals/connection'
import { VoxDiagnostics, errorDetails, observeWake, peerDetails, trackDetails } from './diagnostics'
import { getSettings, subscribeSettings, useSettings } from '../settings/model'
import type { Discovery } from '../projects/model'

export type VoxTask = { id: string; title: string; project: string; phase: string; status: string; result?: string; error?: string; needsInput?: boolean; url: string }
export type VoxItem = { id: string; role: 'user' | 'assistant'; text: string }
export type ConversationReference = {
  id: string; title: string; url: string; status?: string; project?: string; updatedAt?: number
  parent?: ConversationReference | null; children?: ConversationReference[]; childCount?: number
  detached?: boolean; paused?: boolean
}
type ConversationResult = { chats?: ConversationReference[]; chat?: ConversationReference; chatId?: string; title?: string;
  url?: string; status?: string; paused?: boolean; messageId?: string }
type Item = VoxItem
type Session = { id: string; profile: string; auth: string | null; model?: string; greeting?: Item }
type Event = { kind: string; action?: string; stage?: string; details?: Record<string, unknown>; id?: string; role?: Item['role']; text?: string; phase?: string; message?: string; connected?: boolean; name?: string; status?: string; task?: VoxTask; result?: VoxTask | Discovery | { tasks?: VoxTask[] } | ConversationResult }

class VoxConnection {
  private socket = sessionSocket('/api/vox/ws')
  private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()
  private ready = false
  constructor(private debug: VoxDiagnostics, onReady: () => void, onEvent: (sessionId: string, event: Event) => void, onClose: (message: string) => void) {
    let reason = ''
    debug.log('socket-connecting')
    this.socket.onopen = () => debug.log('socket-open')
    this.socket.onerror = () => debug.log('socket-error', {}, 'warn')
    this.socket.onmessage = (raw) => {
      let message
      try { message = JSON.parse(raw.data) } catch { reason = 'Invalid Vox response.'; this.socket.close(); return }
      if (message.type === 'ready') { debug.log('socket-ready'); this.ready = true; onReady(); return }
      if (message.type === 'fatal') { reason = message.message; debug.log('socket-fatal', { message: reason }, 'warn'); this.socket.close(); return }
      if (message.type === 'event') { onEvent(message.sessionId, message.event); return }
      if (message.type === 'wake-event') { onEvent(message.key, { ...message.event, kind: `wake-${message.event.kind}` }); return }
      const pending = this.pending.get(message.id)
      if (!pending) return
      clearTimeout(pending.timer); this.pending.delete(message.id)
      if (message.type === 'error') pending.reject(new Error(message.message))
      else pending.resolve(message.result)
    }
    this.socket.onclose = (event) => {
      debug.log('socket-closed', { code: event.code, clean: event.wasClean, message: reason }, 'warn')
      this.ready = false
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason || 'Vox disconnected.')) }
      this.pending.clear(); onClose(reason || 'Vox disconnected. Background investigations remain in Chat.')
    }
  }
  request<T>(op: string, args: object): Promise<T> {
    if (!this.ready || this.socket.readyState !== WebSocket.OPEN) {
      this.debug.log('request-rejected', { op, reason: 'socket-not-ready' }, 'warn')
      return Promise.reject(new Error('Connect Vox first.'))
    }
    if (this.pending.size >= 8 || this.socket.bufferedAmount > 128 * 1024) return Promise.reject(new Error('Vox is busy.'))
    const id = requestId(), payload = JSON.stringify({ id, op, args })
    if (new TextEncoder().encode(payload).byteLength > 65536) return Promise.reject(new Error('Vox request is too large.'))
    return new Promise((resolve, reject) => {
      const started = this.debug.enabled ? performance.now() : null
      this.debug.log('request-sent', { op })
      const timer = setTimeout(() => { this.pending.delete(id); this.debug.log('request-timeout', { op }, 'warn'); reject(new Error('Vox request timed out. Its outcome is unconfirmed.')) }, op === 'offer' || op === 'wake-offer' ? 245000 : 125000)
      this.pending.set(id, {
        resolve: (value) => { this.debug.log('request-completed', () => ({ op, elapsedMs: started === null ? null : Math.round(performance.now() - started) })); resolve(value as T) },
        reject: (error) => { this.debug.log('request-failed', { op, ...errorDetails(error) }, 'warn'); reject(error) }, timer,
      }); this.socket.send(payload)
    })
  }
  close() { this.socket.close() }
  snapshot() { return { ready: this.ready, state: this.socket.readyState, pendingRequests: this.pending.size } }
}

export function useVox() {
  const { debugMode } = useSettings()
  const diagnostic = useRef<VoxDiagnostics | null>(null)
  if (!diagnostic.current) diagnostic.current = new VoxDiagnostics()
  const debug = diagnostic.current
  const diagnosticSnapshot = useRef<() => Record<string, unknown>>(() => ({}))
  const connection = useRef<VoxConnection | null>(null)
  const current = useRef<Session | null>(null)
  const mounted = useRef(true)
  const media = useRef<{ stream: MediaStream; peer: RTCPeerConnection; audio: HTMLAudioElement } | null>(null)
  const audioGeneration = useRef(0)
  const outputMuted = useRef(false)
  const inputMuted = useRef(false)
  const starting = useRef(false)
  const startingSession = useRef<string | null>(null)
  const startGeneration = useRef(0)
  const ending = useRef(false)
  const wakeMedia = useRef<{ stream: MediaStream; peer: RTCPeerConnection; signaled: boolean; stopDiagnostics: () => void } | null>(null)
  const wakeKey = useRef<string | null>(null)
  const wakeGeneration = useRef(0)
  const onWake = useRef<(() => void) | null>(null)
  const [wakeStatus, setWakeStatus] = useState<'off' | 'preparing' | 'ready'>('off')
  const [status, setStatus] = useState('idle')
  const [session, setSession] = useState<Session | null>(null)
  const [phase, setPhase] = useState('ready')
  const [error, setError] = useState('')
  const [items, setItems] = useState<Item[]>([])
  const [tasks, setTasks] = useState<VoxTask[]>([])
  const [conversations, setConversations] = useState<ConversationReference[]>([])
  const [tool, setTool] = useState('')
  const [audioConnecting, setAudioConnecting] = useState(false)
  const [audioActive, setAudioActive] = useState(false)
  const [muted, setMuted] = useState(false)
  const [speakerMuted, setSpeakerMuted] = useState(false)
  const [playbackBlocked, setPlaybackBlocked] = useState(false)
  const busy = phase === 'starting' || phase === 'ending'
  diagnosticSnapshot.current = () => ({ socket: connection.current?.snapshot() ?? null, status, phase,
    wakeStatus, wakePeer: peerDetails(wakeMedia.current?.peer), wakeTracks: trackDetails(wakeMedia.current?.stream),
    callActive: !!current.current, callStarting: starting.current, callEnding: ending.current,
    callPeer: peerDetails(media.current?.peer), callTracks: trackDetails(media.current?.stream),
    microphoneMuted: inputMuted.current, speakerMuted: outputMuted.current, playbackBlocked, error })
  function releaseMedia() {
    audioGeneration.current++
    const active = media.current; media.current = null
    if (active) {
      active.stream.getTracks().forEach((track) => track.stop())
      active.peer.onconnectionstatechange = null; active.peer.ontrack = null; active.peer.close()
      active.audio.pause(); active.audio.srcObject = null
    }
    if (mounted.current) { setAudioConnecting(false); setAudioActive(false); setMuted(false); setPlaybackBlocked(false) }
    inputMuted.current = false
  }
  function releaseWake() {
    wakeGeneration.current++
    const active = wakeMedia.current; wakeMedia.current = null; wakeKey.current = null
    if (active) {
      active.stopDiagnostics()
      active.stream.getTracks().forEach((track) => track.stop())
      active.peer.onconnectionstatechange = null; active.peer.close()
    }
    if (mounted.current) setWakeStatus('off')
    debug.log('wake-capture-released')
  }
  async function stopWake() {
    const key = wakeKey.current
    releaseWake()
    if (key) await connection.current?.request('wake-stop', { key })
  }
  async function startWake() {
    if (wakeKey.current) { debug.log('wake-start-ignored', { reason: 'already-enabled' }); return }
    debug.log('wake-enable-requested', { secureContext: window.isSecureContext, microphoneApi: !!navigator.mediaDevices?.getUserMedia })
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('Hey Vox requires HTTPS or localhost and microphone access.'); return
    }
    const generation = ++wakeGeneration.current, key = requestId()
    wakeKey.current = key; setWakeStatus('preparing'); setError('')
    try {
      debug.log('wake-microphone-requested')
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      if (wakeGeneration.current !== generation) { stream.getTracks().forEach((track) => track.stop()); return }
      const peer = new RTCPeerConnection()
      debug.log('wake-microphone-acquired', () => ({ tracks: trackDetails(stream) }))
      wakeMedia.current = { stream, peer, signaled: false,
        stopDiagnostics: debug.enabled ? observeWake(peer, stream, debug) : () => {} }
      stream.getAudioTracks().forEach((track) => {
        peer.addTrack(track, stream)
        track.addEventListener('ended', () => { void stopWake().catch(() => {}) }, { once: true })
      })
      peer.onconnectionstatechange = () => {
        if (wakeMedia.current?.peer !== peer) return
        if (peer.connectionState === 'connected') { debug.log('wake-ready'); setWakeStatus('ready') }
        else if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
          setError('Hey Vox disconnected. Enable it again to resume.'); void stopWake().catch(() => {})
        }
      }
      peer.createDataChannel('pipecat')
      await peer.setLocalDescription(await peer.createOffer())
      debug.log('wake-local-offer-ready', { ...peerDetails(peer) })
      if (peer.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Could not prepare Hey Vox audio.')), 10000)
        peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve() } })
      })
      if (wakeGeneration.current !== generation) return
      wakeMedia.current!.signaled = true
      const answer = await connection.current!.request<{ sdp: string; type: RTCSdpType }>('wake-offer', { key, type: 'offer', sdp: peer.localDescription!.sdp, debug: getSettings().debugMode })
      if (wakeGeneration.current !== generation) return
      await peer.setRemoteDescription(answer)
      debug.log('wake-server-answer-applied', { ...peerDetails(peer) })
    } catch (cause) {
      debug.log('wake-start-failed', errorDetails(cause), 'warn')
      if (wakeGeneration.current === generation) {
        releaseWake()
        setError(cause instanceof Error ? cause.message : 'Hey Vox could not start.')
        void connection.current?.request('wake-stop', { key }).catch(() => {})
      }
    }
  }
  function setMicrophoneMuted(value: boolean) {
    inputMuted.current = value
    media.current?.stream.getAudioTracks().forEach((track) => { track.enabled = !value })
    setMuted(value)
  }
  function applySpeakerMute(value: boolean) {
    outputMuted.current = value
    if (media.current) media.current.audio.muted = value
    setSpeakerMuted(value)
  }
  function control(action: string) {
    debug.log('call-control', { action })
    if (action === 'mute_microphone') setMicrophoneMuted(true)
    else if (action === 'unmute_microphone') setMicrophoneMuted(false)
    else if (action === 'mute_speaker') applySpeakerMute(true)
    else if (action === 'unmute_speaker') applySpeakerMute(false)
    else if (action === 'end_call') void end()
    else if (action === 'go_offline') {
      void stopWake().catch(() => {}); void end()
    }
  }
  function rememberTask(task: VoxTask) {
    setTasks((previous) => [task, ...previous.filter((item) => item.id !== task.id)].slice(0, 30))
  }
  function connect() {
    if (connection.current) return
    setStatus('connecting'); setError('')
    const live = new VoxConnection(debug, () => { if (connection.current === live) setStatus('connected') }, (id, event) => {
      if (event.kind.startsWith('wake-')) {
        if (id !== wakeKey.current) { debug.log('wake-event-ignored', { reason: 'stale-listener', kind: event.kind }); return }
        if (event.kind === 'wake-diagnostic') {
          const stalled = event.stage === 'audio' && event.details?.framesReceived === 0
          debug.log(`wake-server-${event.stage ?? 'diagnostic'}`, event.details, event.stage === 'pipeline-error' || stalled ? 'warn' : 'info'); return
        }
        if (event.kind === 'wake-error') {
          debug.log('wake-server-error', { message: event.message }, 'warn')
          setError(event.message ?? 'Hey Vox detector stopped. Check voice diagnostics.'); void stopWake().catch(() => {}); return
        }
        if (event.kind === 'wake-disconnected') { debug.log('wake-server-disconnected', {}, 'warn'); void stopWake().catch(() => {}); return }
        debug.log('wake-keyword-detected', { action: event.action })
        if (event.action === 'wake' && !current.current && !starting.current && !ending.current) {
          if (onWake.current) { debug.log('wake-auto-call-triggered'); onWake.current() }
          else debug.log('wake-auto-call-ignored', { reason: 'no-call-handler' }, 'warn')
        }
        else if (event.action === 'wake') debug.log('wake-auto-call-ignored', { callActive: !!current.current, starting: starting.current, ending: ending.current })
        else if (event.action && event.action !== 'wake') control(event.action)
        return
      }
      if (event.kind === 'startup-timing') {
        if (id === startingSession.current || id === current.current?.id)
          debug.log('call-startup-stage', { stage: event.stage, ...event.details })
        return
      }
      if (id !== current.current?.id) return
      if (event.kind === 'control' && event.action) { control(event.action); return }
      if (event.kind === 'message' && event.id && event.role) {
        const item = { id: event.id, role: event.role, text: event.text ?? '' }
        setItems((previous) => [...previous.filter((value) => value.id !== item.id), item].slice(-100))
      } else if (event.kind === 'delta') {
        setItems((previous) => previous.map((item) => item.id === event.id ? { ...item, text: (item.text + event.text).slice(-65536) } : item))
      } else if (event.kind === 'phase') { debug.log('call-phase', { phase: event.phase }); setPhase(event.phase ?? 'ready'); if (event.phase === 'ready' || event.phase === 'listening') setTool('') }
      else if (event.kind === 'error') setError(event.message ?? 'Vox could not complete that request.')
      else if (event.kind === 'audio' && !event.connected) releaseMedia()
      else if (event.kind === 'task' && event.task) rememberTask(event.task)
      else if (event.kind === 'ended') { releaseMedia(); current.current = null; setSession(null); setPhase('ready') }
      else if (event.kind === 'tool') {
        setTool(event.status === 'running' ? event.name ?? '' : '')
        const result = event.result
        if (result && 'id' in result && 'phase' in result && 'project' in result) rememberTask(result)
        else if (result && 'tasks' in result) for (const task of result.tasks ?? []) rememberTask(task)
        if (result && 'chats' in result) setConversations(result.chats ?? [])
        else if (result && 'chat' in result && result.chat) setConversations([result.chat])
        else if (result && 'chatId' in result && result.chatId && result.url) setConversations((previous) => [{
          ...previous.find((chat) => chat.id === result.chatId), id: result.chatId!, title: result.title ?? previous.find((chat) => chat.id === result.chatId)?.title ?? 'Conversation',
          url: result.url!, status: result.status, paused: result.paused,
        }])
      }
    }, (message) => {
      if (connection.current !== live) return
      releaseMedia(); releaseWake(); current.current = null; connection.current = null
      if (mounted.current) { setSession(null); setStatus('offline'); setPhase('ready'); setError(message) }
    })
    connection.current = live
  }
  async function start(profile: string | null) {
    if (current.current || starting.current || ending.current) {
      debug.log('call-start-ignored', { active: !!current.current, starting: starting.current, ending: ending.current }); return
    }
    debug.log('call-start-requested', { selection: profile ? 'selected-profile' : 'auto' })
    starting.current = true
    const key = requestId()
    startingSession.current = key
    const generation = ++startGeneration.current
    setPhase('starting'); setError(''); setItems([]); setConversations([])
    outputMuted.current = false; setSpeakerMuted(false)
    inputMuted.current = false; setMuted(false)
    try {
      const value = await connection.current!.request<Session>('start', { key, profile })
      if (generation !== startGeneration.current) {
        await connection.current?.request('end', { sessionId: value.id })
        setPhase('ready'); return
      }
      current.current = value; setSession(value); setItems(value.greeting ? [value.greeting] : []); setPhase('ready')
      debug.log('call-started')
      return value
    } catch (cause) { debug.log('call-start-failed', errorDetails(cause), 'warn'); setPhase('ready'); setError(cause instanceof Error ? cause.message : 'Vox could not start.') }
    finally { starting.current = false; startingSession.current = null }
  }
  async function send(text: string) {
    const active = current.current
    if (!active) return
    setError('')
    await connection.current!.request('text', { sessionId: active.id, text })
  }
  async function interrupt() {
    const active = current.current
    if (active) await connection.current!.request('interrupt', { sessionId: active.id })
  }
  async function stopAudio() {
    releaseMedia()
    const active = current.current
    if (active) {
      try { await connection.current!.request('audio-stop', { sessionId: active.id }) }
      catch (cause) { if (mounted.current) setError(cause instanceof Error ? cause.message : 'Microphone is off; remote stop is unconfirmed.') }
    }
  }
  async function startAudio() {
    const active = current.current
    if (!active || media.current || audioConnecting) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setError('Microphone access requires HTTPS or localhost and a supported browser.'); return
    }
    const generation = ++audioGeneration.current
    debug.log('call-audio-requested', { reusingWakeMicrophone: !!wakeMedia.current })
    setAudioConnecting(true); setError('')
    try {
      const stream = wakeMedia.current?.stream.clone() ?? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false })
      debug.log('call-microphone-acquired')
      if (audioGeneration.current !== generation || current.current !== active) { stream.getTracks().forEach((track) => track.stop()); return }
      stream.getAudioTracks().forEach((track) => { track.enabled = false; track.addEventListener('ended', () => { void stopAudio() }, { once: true }) })
      const peer = new RTCPeerConnection(), audio = new Audio()
      media.current = { stream, peer, audio }; audio.autoplay = true; audio.muted = outputMuted.current
      peer.ontrack = (event) => {
        audio.srcObject = event.streams[0] ?? new MediaStream([event.track])
        void audio.play().catch((cause) => { debug.log('call-playback-blocked', errorDetails(cause), 'warn'); setPlaybackBlocked(true) })
      }
      peer.onconnectionstatechange = () => {
        if (media.current?.peer !== peer) return
        debug.log('call-peer-state', { ...peerDetails(peer) })
        if (peer.connectionState === 'connected') {
          stream.getAudioTracks().forEach((track) => { track.enabled = !inputMuted.current }); setAudioActive(true); setAudioConnecting(false)
        } else if (['failed', 'disconnected', 'closed'].includes(peer.connectionState)) {
          setError('Microphone connection lost. You can reconnect or keep typing.'); void stopAudio()
        }
      }
      stream.getAudioTracks().forEach((track) => peer.addTrack(track, stream))
      peer.createDataChannel('pipecat')
      await peer.setLocalDescription(await peer.createOffer())
      debug.log('call-local-offer-ready', { ...peerDetails(peer) })
      if (peer.iceGatheringState !== 'complete') await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Could not prepare the microphone connection.')), 10000)
        peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); resolve() } })
      })
      if (audioGeneration.current !== generation) return
      debug.log('call-ice-gathering-complete', { ...peerDetails(peer) })
      const answer = await connection.current!.request<{ sdp: string; type: RTCSdpType }>('offer', { sessionId: active.id, type: 'offer', sdp: peer.localDescription!.sdp })
      if (audioGeneration.current !== generation || media.current?.peer !== peer) return
      await peer.setRemoteDescription({ type: answer.type, sdp: answer.sdp })
      debug.log('call-server-answer-applied', { ...peerDetails(peer) })
    } catch (cause) {
      debug.log('call-audio-failed', errorDetails(cause), 'warn')
      if (audioGeneration.current === generation) {
        releaseMedia()
        setError(cause instanceof DOMException && cause.name === 'NotAllowedError' ? 'Microphone access was denied. Allow it in your browser’s site settings.' :
          cause instanceof Error ? cause.message : 'Microphone connection failed.')
        if (current.current === active) void connection.current?.request('audio-stop', { sessionId: active.id }).catch(() => {})
      }
    }
  }
  async function end() {
    if (ending.current) return
    startGeneration.current++
    releaseMedia()
    const active = current.current
    if (!active) { setPhase('ready'); return }
    ending.current = true
    setPhase('ending')
    try { await connection.current!.request('end', { sessionId: active.id }); current.current = null; setSession(null); setPhase('ready'); return true }
    catch (cause) { setPhase('ready'); setError(cause instanceof Error ? cause.message : 'Vox stop is unconfirmed.'); return false }
    finally { ending.current = false }
  }
  function toggleMute() {
    setMicrophoneMuted(!inputMuted.current)
  }
  function toggleSpeaker() {
    applySpeakerMute(!outputMuted.current)
  }
  async function play() { await media.current?.audio.play(); setPlaybackBlocked(false) }
  useEffect(() => {
    const api = { export: () => debug.report(diagnosticSnapshot.current) }
    const visibility = () => debug.log('tab-visibility', { state: document.visibilityState })
    const updateDebug = () => {
      const enabled = getSettings().debugMode
      document.removeEventListener('visibilitychange', visibility)
      if (enabled) {
        window.aixandVoxDiagnostics = api
        document.addEventListener('visibilitychange', visibility)
        debug.log('diagnostics-ready', { version: 'vox-diagnostics-v1' })
      } else {
        debug.clear()
        if (window.aixandVoxDiagnostics === api) delete window.aixandVoxDiagnostics
      }
      const active = wakeMedia.current
      if (active) {
        active.stopDiagnostics()
        active.stopDiagnostics = enabled ? observeWake(active.peer, active.stream, debug) : () => {}
        if (active.signaled && wakeKey.current)
          void connection.current?.request('wake-debug', { key: wakeKey.current, enabled }).catch((cause) => debug.log('wake-debug-update-failed', () => errorDetails(cause), 'warn'))
      }
    }
    updateDebug()
    const unsubscribe = subscribeSettings(updateDebug)
    return () => {
      unsubscribe(); document.removeEventListener('visibilitychange', visibility); debug.clear()
      if (window.aixandVoxDiagnostics === api) delete window.aixandVoxDiagnostics
    }
  }, [])
  useEffect(() => {
    mounted.current = true
    const hide = () => { releaseMedia(); releaseWake(); connection.current?.close() }
    window.addEventListener('pagehide', hide)
    return () => {
      mounted.current = false; window.removeEventListener('pagehide', hide)
      releaseMedia(); releaseWake(); connection.current?.close()
    }
  }, [])
  return { connect, start, send, interrupt, startAudio, stopAudio, end, toggleMute, toggleSpeaker, play, startWake, stopWake,
    setOnWake: (handler: () => void) => { onWake.current = handler }, wakeStatus,
    debugEnabled: debugMode, diagnosticReport: () => debug.report(diagnosticSnapshot.current),
    status, session, phase, error, setError, items, tasks, conversations, tool, audioConnecting, audioActive, muted, speakerMuted, playbackBlocked, busy }
}
