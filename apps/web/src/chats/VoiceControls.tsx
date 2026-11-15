import { Button, Icon, Tooltip } from 'bbb-design'
import type { VoiceModel } from './voice'
import './voice.css'

function Microphone({ muted = false }: { muted?: boolean }) {
  return <Icon name={muted ? 'mic-off' : 'mic'} className="command-microphone-icon" />
}

export function VoiceButton({ voice, disabled, onStart }: { voice: VoiceModel; disabled: boolean; onStart: () => void }) {
  const label = voice.phase === 'stop-failed' ? 'Retry stop voice' : voice.engaged ? 'Stop voice chat' : 'Start voice chat'
  return <Tooltip content={voice.unavailable || (disabled && !voice.engaged ? 'Connect a Codex chat to use voice' : label)}>
    <Button type="button" variant="ghost" size="sm" iconOnly className="command-voice-button"
      aria-label={label} aria-pressed={voice.engaged} data-active={voice.engaged || undefined}
      disabled={voice.phase === 'stopping' || (!voice.engaged && (disabled || Boolean(voice.unavailable)))}
      onPress={() => { if (voice.engaged) void voice.stop(); else onStart() }}>
      <Microphone muted={voice.muted || voice.phase === 'stop-failed'} />
    </Button>
  </Tooltip>
}

export function VoicePanel({ voice }: { voice: VoiceModel }) {
  if (!voice.engaged && !voice.error && !voice.captions.length) return null
  const status = voice.phase === 'permission' ? 'Allow microphone access to start voice.' :
    voice.phase === 'connecting' ? 'Connecting voice…' : voice.phase === 'active' ? voice.muted ? 'Microphone muted' : 'Voice on · Listening' :
      voice.phase === 'stopping' ? 'Ending voice…' : voice.phase === 'stop-failed' ? 'Microphone off · Retry stop' : 'Voice ended'
  return <section className="command-voice-panel" aria-label="Voice chat">
    <div className="command-voice-heading">
      <p role="status"><span className="command-voice-dot" data-listening={voice.phase === 'active' && !voice.muted || undefined} aria-hidden="true" />{status}</p>
      <div className="command-voice-actions">
        {voice.phase === 'active' && <Button type="button" variant="ghost" size="sm" aria-label={voice.muted ? 'Unmute microphone' : 'Mute microphone'}
          aria-pressed={voice.muted} onPress={voice.toggleMute}><Microphone muted={voice.muted} />{voice.muted ? 'Unmute' : 'Mute'}</Button>}
        {voice.playbackBlocked && <Button type="button" variant="ghost" size="sm" onPress={() => { void voice.play() }}>Play voice replies</Button>}
      </div>
    </div>
    {voice.error && <p className="command-voice-error" role="alert">{voice.error}</p>}
    {!!voice.captions.length && <div className="command-voice-captions" role="log" aria-label="Voice captions" aria-live="polite">
      {voice.captions.map((caption) => <p key={caption.id}><strong>{caption.role === 'user' ? 'You' : 'Codex'}</strong><span>{caption.text}</span></p>)}
    </div>}
  </section>
}
