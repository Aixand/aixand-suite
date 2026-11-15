import { getSettings } from '../settings/model'

type Details = Record<string, unknown>
type Entry = { time: string; event: string; level: 'info' | 'warn'; details: Details }
export const DIAGNOSTIC_LIMITS = { events: 200, bufferBytes: 128 * 1024, reportBytes: 256 * 1024,
  eventBytes: 4096, consoleMessages: 200 }
const encoder = new TextEncoder()
const bytes = (value: string) => encoder.encode(value).byteLength
let consoleMessages = 0

function bounded(value: unknown): Details {
  let remaining = 64
  const seen = new WeakSet<object>()
  function copy(item: unknown, depth = 0): unknown {
    if (--remaining < 0 || depth > 4) return '[Truncated]'
    if (typeof item === 'string') return item.slice(0, 256)
    if (typeof item === 'number') return Number.isFinite(item) ? item : null
    if (typeof item === 'boolean' || item === null || item === undefined) return item
    if (typeof item !== 'object') return '[Unsupported]'
    if (seen.has(item)) return '[Circular]'
    seen.add(item)
    if (Array.isArray(item)) return item.slice(0, 16).map((child) => copy(child, depth + 1))
    const result: Details = Object.create(null)
    for (const [key, child] of Object.entries(item).slice(0, 24)) result[key.slice(0, 80)] = copy(child, depth + 1)
    return result
  }
  try { return copy(value) as Details } catch { return { omitted: 'Invalid diagnostic value' } }
}

declare global {
  interface Window {
    aixandVoxDiagnostics?: { export: () => string }
  }
}

// Keep connection metadata and aggregate levels; never collect audio, SDP,
// device identifiers, credentials, or conversation contents.
export class VoxDiagnostics {
  private entries: { entry: Entry; bytes: number }[] = []
  private bufferBytes = 0
  get enabled() { return getSettings().debugMode }
  clear() { this.entries = []; this.bufferBytes = 0 }
  log(event: string, details: Details | (() => Details) = {}, level: Entry['level'] = 'info') {
    if (!this.enabled) return
    let resolved: Details
    try { resolved = typeof details === 'function' ? details() : details }
    catch { resolved = { omitted: 'Diagnostic metadata unavailable' } }
    const entry = { time: new Date().toISOString(), event: event.slice(0, 100), level,
      details: bounded(resolved) }
    let size = bytes(JSON.stringify(entry))
    if (size > DIAGNOSTIC_LIMITS.eventBytes) {
      entry.details = { omitted: 'Exceeded event size limit' }; size = bytes(JSON.stringify(entry))
    }
    this.entries.push({ entry, bytes: size }); this.bufferBytes += size
    while (this.entries.length > DIAGNOSTIC_LIMITS.events || this.bufferBytes > DIAGNOSTIC_LIMITS.bufferBytes)
      this.bufferBytes -= this.entries.shift()!.bytes
    if (consoleMessages >= DIAGNOSTIC_LIMITS.consoleMessages) return
    consoleMessages++
    if (consoleMessages === DIAGNOSTIC_LIMITS.consoleMessages)
      console.info('[Vox] Console limit reached. Copy diagnostics for the latest rolling report.')
    else console[level](`[Vox] ${entry.event}`, entry.details)
  }
  report(snapshot: () => Details) {
    if (!this.enabled) { this.clear(); return JSON.stringify({ version: 'vox-diagnostics-v1', debugEnabled: false, events: [] }) }
    const events = this.entries.map((item) => item.entry)
    let current: Details
    try { current = bounded(snapshot()) } catch { current = { omitted: 'Snapshot unavailable' } }
    const report = { version: 'vox-diagnostics-v1', debugEnabled: true, exportedAt: new Date().toISOString(),
      limits: DIAGNOSTIC_LIMITS, bufferBytes: this.bufferBytes, omittedEvents: 0,
      environment: { browser: navigator.userAgent.slice(0, 512), secureContext: window.isSecureContext, visibility: document.visibilityState },
      snapshot: current, events }
    let result = JSON.stringify(report, null, 2)
    while (bytes(result) > DIAGNOSTIC_LIMITS.reportBytes && events.length) {
      events.shift(); report.omittedEvents++; result = JSON.stringify(report, null, 2)
    }
    return result
  }
}

export function trackDetails(stream?: MediaStream) {
  return stream?.getAudioTracks().map((track) => {
    const settings = track.getSettings()
    return { enabled: track.enabled, muted: track.muted, readyState: track.readyState,
      sampleRate: settings.sampleRate, channelCount: settings.channelCount,
      echoCancellation: settings.echoCancellation, noiseSuppression: settings.noiseSuppression,
      autoGainControl: settings.autoGainControl }
  }) ?? []
}

export function peerDetails(peer?: RTCPeerConnection) {
  return peer ? { connection: peer.connectionState, ice: peer.iceConnectionState,
    gathering: peer.iceGatheringState, signaling: peer.signalingState } : null
}

export function observeWake(peer: RTCPeerConnection, stream: MediaStream, debug: VoxDiagnostics) {
  let stopped = false, sampling = false, previousBytes = 0, previousEnergy = 0, previousDuration = 0
  const state = () => debug.log('wake-peer-state', { ...peerDetails(peer) })
  const events = ['connectionstatechange', 'iceconnectionstatechange', 'icegatheringstatechange', 'signalingstatechange']
  events.forEach((name) => peer.addEventListener(name, state))
  const trackState = () => debug.log('wake-microphone-state', { tracks: trackDetails(stream) })
  const trackEvents = ['mute', 'unmute', 'ended']
  stream.getAudioTracks().forEach((track) => trackEvents.forEach((name) => track.addEventListener(name, trackState)))
  const sample = async () => {
    if (stopped || !debug.enabled || sampling || peer.connectionState === 'closed') return
    sampling = true
    try {
      const stats = await peer.getStats()
      if (stopped || !debug.enabled) return
      let bytes = 0, packets = 0, energy = 0, duration = 0, route: Details | undefined
      for (const item of stats.values()) {
        if (item.type === 'outbound-rtp' && item.kind === 'audio') {
          bytes += item.bytesSent ?? 0; packets += item.packetsSent ?? 0
        } else if (item.type === 'media-source' && item.kind === 'audio') {
          energy += item.totalAudioEnergy ?? 0; duration += item.totalSamplesDuration ?? 0
        } else if (item.type === 'transport' && item.selectedCandidatePairId) {
          const pair = stats.get(item.selectedCandidatePairId)
          const local = pair && stats.get(pair.localCandidateId), remote = pair && stats.get(pair.remoteCandidateId)
          route = { localType: local?.candidateType, remoteType: remote?.candidateType,
            protocol: local?.protocol, roundTripSeconds: pair?.currentRoundTripTime }
        }
      }
      const seconds = duration - previousDuration
      debug.log('wake-browser-audio', { ...peerDetails(peer), tracks: trackDetails(stream), bytesSent: bytes,
        bytesSinceLastReport: bytes - previousBytes, packetsSent: packets,
        inputRms: seconds > 0 ? Number(Math.sqrt(Math.max(0, energy - previousEnergy) / seconds).toFixed(5)) : null,
        route })
      previousBytes = bytes; previousEnergy = energy; previousDuration = duration
    } catch (cause) {
      if (!stopped) debug.log('wake-stats-error', errorDetails(cause), 'warn')
    } finally { sampling = false }
  }
  const timer = setInterval(() => { void sample() }, 5000)
  const waiting = setTimeout(() => {
    if (peer.connectionState !== 'connected') debug.log('wake-connection-still-waiting', { ...peerDetails(peer) }, 'warn')
  }, 20000)
  return () => {
    stopped = true; clearInterval(timer); clearTimeout(waiting)
    events.forEach((name) => peer.removeEventListener(name, state))
    stream.getAudioTracks().forEach((track) => trackEvents.forEach((name) => track.removeEventListener(name, trackState)))
  }
}

export function errorDetails(cause: unknown): Details {
  return cause instanceof Error ? { name: cause.name, message: cause.message.slice(0, 300) } : { message: 'Unknown error' }
}
