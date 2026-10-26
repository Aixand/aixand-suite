import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { TerminalConnection, decodeBytes, encodeBytes } from './connection'
import type { Session, TerminalEvent } from './connection'

export type PaneState = {
  phase: 'offline' | 'connecting' | 'live' | 'gap' | 'error'
  message?: string
  notice?: string
}

/** One emulator and byte cursor per pane, retained across tab/layout changes. */
export class PaneRuntime {
  readonly terminal: Terminal
  private fit = new FitAddon()
  private client: TerminalConnection | null = null
  private unsubscribe?: () => void
  private stream: string | null = null
  private offset = '0'
  private receivedOffset = '0'
  private disposed = false
  private visible = true
  private generation = 0
  private queue: Uint8Array[] = []
  private queueBytes = 0
  private sending = false
  private resizeTimer?: ReturnType<typeof setTimeout>
  private observer: ResizeObserver
  private themeObserver: MutationObserver
  private lastSize = ''
  private resizing = false
  private phase: PaneState['phase'] = 'offline'
  private resumeAttempted = false
  private screenAttempted = false
  private waitingForScreen = false
  private screenTimer?: ReturnType<typeof setTimeout>
  private recoveryTimer?: ReturnType<typeof setTimeout>
  private restoredScreen = false
  private historyGap = false

  constructor(
    private host: HTMLElement,
    private paneId: string,
    private session: Session,
    private change: (state: PaneState) => void,
    private readOnly = false,
  ) {
    this.terminal = new Terminal({
      cursorBlink: !readOnly,
      disableStdin: true,
      scrollback: 5000,
      overviewRuler: { width: parseFloat(getComputedStyle(host).getPropertyValue('--ax-scrollbar-size')) || 4 },
      fontFamily: '"Monaspace Neon", ui-monospace, monospace',
      fontSize: 13,
      screenReaderMode: true,
      minimumContrastRatio: 4.5,
      theme: this.readTheme(),
    })
    this.terminal.loadAddon(this.fit)
    this.terminal.open(host)
    this.terminal.textarea?.setAttribute(
      'aria-label',
      `${readOnly ? 'Terminal preview' : 'Terminal input'} for ${session.name}`
    )
    if (readOnly && this.terminal.textarea) this.terminal.textarea.readOnly = true
    this.terminal.onData((data) => this.input(new TextEncoder().encode(data)))
    this.terminal.onBinary((data) =>
      this.input(Uint8Array.from(data, (char) => char.charCodeAt(0)))
    )
    this.observer = new ResizeObserver(() => this.scheduleFit())
    this.observer.observe(host)
    this.themeObserver = new MutationObserver(() => {
      this.terminal.options.theme = this.readTheme()
    })
    const theme = host.closest('[data-bbb-theme]')
    if (theme) {
      this.themeObserver.observe(theme, {
        attributes: true,
        attributeFilter: ['data-bbb-mode', 'style'],
      })
    }
    this.scheduleFit()
  }
  private readTheme() {
    const styles = getComputedStyle(this.host)
    const color = (name: string) =>
      styles.getPropertyValue(`--ax-terminal-${name}`).trim()
    return {
      background: color('bg'),
      foreground: color('text'),
      cursor: color('cursor'),
      cursorAccent: color('bg'),
      selectionBackground: color('selection'),
      black: color('black'),
      brightBlack: color('muted'),
      white: styles.getPropertyValue('--bbb-color-text-secondary').trim(),
      brightWhite: color('text'),
      overviewRulerBorder: 'transparent',
    }
  }
  private state(state: PaneState) {
    this.phase = state.phase
    if (state.phase === 'live') {
      if (this.restoredScreen)
        state.notice = this.historyGap
          ? 'Current screen restored. Some earlier output is unavailable.'
          : 'Earlier scrollback and some terminal modes may be unavailable.'
      // A snapshot can itself be followed by a gap. Restore the retry budget
      // only after its stream has settled or delivered contiguous output.
      clearTimeout(this.recoveryTimer)
      this.recoveryTimer = setTimeout(() => {
        this.resumeAttempted = false
        this.screenAttempted = false
      }, 1000)
    }
    if (!this.disposed) this.change(state)
  }
  private stopInput() {
    clearTimeout(this.screenTimer)
    clearTimeout(this.recoveryTimer)
    this.waitingForScreen = false
    this.terminal.options.disableStdin = true
    this.queue = []
    this.queueBytes = 0
    this.generation++
  }
  clear() {
    // Keep the parser modes, stream, and replay cursor intact. This only clears
    // this browser's display; it does not send a command or delete daemon logs.
    this.terminal.write('\x1b[2J\x1b[3J\x1b[H')
    this.focus()
  }
  setSession(session: Session) {
    const previous = this.session
    this.session = session
    if (!this.running() && this.phase === 'live') this.stopInput()
    this.terminal.options.disableStdin =
      this.readOnly || this.phase !== 'live' || !this.running()
    if (
      this.client &&
      session.lifecycle.state === 'running' &&
      (previous.lifecycle.state !== 'running' ||
        previous.started_at_millis !== session.started_at_millis ||
        previous.restart_count !== session.restart_count)
    )
      void this.attach(true)
  }
  private running() {
    return ['running', 'starting'].includes(this.session.lifecycle.state)
  }
  setVisible(visible: boolean) {
    this.visible = visible
    if (visible) this.scheduleFit()
  }
  focus() {
    if (this.visible) this.terminal.focus()
  }
  async connect(client: TerminalConnection | null) {
    if (this.client === client || this.disposed) return
    this.unsubscribe?.()
    this.stopInput()
    this.stream = null
    this.client = client
    this.lastSize = ''
    if (!client) {
      this.state({ phase: 'offline' })
      return
    }
    this.unsubscribe = client.subscribe((event) => this.receive(event, client))
    await this.attach(this.readOnly)
  }
  async attach(screen: boolean, automatic = false) {
    const client = this.client
    if (!client || this.disposed) return
    this.stopInput()
    if (!automatic) {
      this.resumeAttempted = false
      this.screenAttempted = false
    }
    this.waitingForScreen = screen
    const generation = this.generation
    this.stream = null
    this.lastSize = ''
    this.state({ phase: 'connecting' })
    try {
      // Finish already received writes before choosing the reconnect cursor.
      await new Promise<void>((resolve) => this.terminal.write('', resolve))
      if (
        this.disposed ||
        client !== this.client ||
        generation !== this.generation
      )
        return
      const result = await client.request<{ stream: string }>('attach', {
        paneId: this.paneId,
        sessionId: this.session.id,
        offset: this.offset,
        screen,
      })
      if (
        this.disposed ||
        client !== this.client ||
        generation !== this.generation
      )
        return
      this.receivedOffset = this.offset
      this.stream = result.stream
      if (screen) {
        // An accepted attachment is not yet a restored display. Keep input
        // paused until xterm has parsed the authoritative screen.
        this.screenTimer = setTimeout(() => {
          if (client === this.client && generation === this.generation) {
            this.stream = null
            this.fail(new Error('The current screen did not arrive. Please try again.'), true)
          }
        }, 10_000)
      } else {
        this.state({ phase: 'live' })
        this.terminal.options.disableStdin = this.readOnly || !this.running()
        this.scheduleFit()
      }
    } catch (cause) {
      if (this.client === client && generation === this.generation)
        this.fail(cause, screen)
    }
  }
  private fail(cause: unknown, screen = false) {
    this.stopInput()
    const message = cause instanceof Error ? cause.message : 'Terminal operation failed.'
    this.state({
      phase: screen ? 'gap' : 'error',
      message: screen ? `Could not restore the current screen. ${message}` : message,
    })
  }
  private recover(screen: boolean, message?: string) {
    if (screen) this.historyGap = true
    const snapshot = screen || this.readOnly || this.waitingForScreen
    if (snapshot ? this.screenAttempted : this.resumeAttempted) {
      this.stream = null
      this.fail(new Error(message ?? 'Terminal output is still interrupted. Please try again.'), snapshot)
      return
    }
    if (snapshot) this.screenAttempted = true
    else this.resumeAttempted = true
    // Reattaching replaces only the output subscription. Never restart the
    // process or replay input whose delivery might already have succeeded.
    void this.attach(snapshot, true)
  }
  private scheduleFit() {
    // A preview follows the session's native dimensions. Resizing its PTY would
    // change the running agent's screen and interfere with workflow observation.
    if (this.readOnly) return
    clearTimeout(this.resizeTimer)
    this.resizeTimer = setTimeout(() => {
      if (
        this.disposed ||
        !this.visible ||
        this.host.clientWidth < 20 ||
        this.host.clientHeight < 20
      )
        return
      const dimensions = this.fit.proposeDimensions()
      if (
        !dimensions ||
        !Number.isFinite(dimensions.cols) ||
        !Number.isFinite(dimensions.rows)
      )
        return
      // Use the same bounded dimensions for the emulator and the remote PTY.
      const columns = Math.max(2, Math.min(500, dimensions.cols)),
        rows = Math.max(1, Math.min(300, dimensions.rows))
      this.terminal.resize(columns, rows)
      const size = `${columns}:${rows}`
      if (
        size === this.lastSize ||
        this.phase !== 'live' ||
        this.session.lifecycle.state !== 'running' ||
        !this.client ||
        this.resizing
      )
        return
      const client = this.client
      const generation = this.generation
      this.resizing = true
      void client
        .request('resize', { sessionId: this.session.id, columns, rows })
        .then(() => {
          if (this.client === client && generation === this.generation)
            this.lastSize = size
        })
        .catch((cause) => {
          if (this.client === client && generation === this.generation)
            this.fail(cause)
        })
        .finally(() => {
          this.resizing = false
          // A slow acknowledgement may arrive after another layout change.
          // Coalesce those changes and send the latest size next.
          if (!this.disposed && this.phase === 'live') this.scheduleFit()
        })
    }, 100)
  }
  private input(bytes: Uint8Array) {
    if (this.readOnly || !this.client || this.terminal.options.disableStdin) return
    if (this.queueBytes + bytes.length > 128 * 1024) {
      this.fail(new Error('Input queue is full. The new input was not sent.'))
      return
    }
    for (let i = 0; i < bytes.length; i += 16384)
      this.queue.push(bytes.slice(i, i + 16384))
    this.queueBytes += bytes.length
    void this.flush()
  }
  private async flush() {
    if (this.sending) return
    this.sending = true
    const client = this.client,
      generation = this.generation
    try {
      while (this.queue.length && client && generation === this.generation) {
        const buffer = new Uint8Array(16384)
        let length = 0
        while (
          this.queue.length &&
          length + this.queue[0].length <= buffer.length
        ) {
          const bytes = this.queue.shift()!
          buffer.set(bytes, length)
          length += bytes.length
        }
        this.queueBytes -= length
        await client.request('input', {
          sessionId: this.session.id,
          data: encodeBytes(buffer.subarray(0, length)),
        })
      }
    } catch (cause) {
      if (generation === this.generation) this.fail(cause)
    } finally {
      this.sending = false
      if (this.queue.length && !this.disposed) void this.flush()
    }
  }
  private receive(event: TerminalEvent, client: TerminalConnection) {
    if (
      this.disposed ||
      client !== this.client ||
      !this.stream ||
      event.stream !== this.stream
    )
      return
    if (event.type === 'gap' || event.type === 'stream-error') {
      this.recover(event.type === 'gap', event.message)
      return
    }
    if (
      !['output', 'screen'].includes(event.type) ||
      event.data === undefined ||
      !event.offset ||
      !event.sequence
    )
      return
    let bytes = decodeBytes(event.data)
    if (event.type === 'screen') {
      clearTimeout(this.screenTimer)
      this.terminal.reset()
      this.terminal.resize(event.columns!, event.rows!)
      if (event.alternateScreen) this.terminal.write('\x1b[?1049h')
      const suffix = new TextEncoder().encode(
        `\x1b[${(event.cursorRow ?? 0) + 1};${(event.cursorColumn ?? 0) + 1}H\x1b[?25${event.cursorVisible === false ? 'l' : 'h'}`
      )
      const combined = new Uint8Array(bytes.length + suffix.length)
      combined.set(bytes)
      combined.set(suffix, bytes.length)
      bytes = combined
      this.lastSize = ''
    } else {
      const start = BigInt(event.start!),
        expected = BigInt(this.receivedOffset)
      if (BigInt(event.offset) <= expected) {
        client.ack(this.stream, event.sequence)
        return
      }
      if (start > expected) {
        this.recover(true)
        return
      }
      if (start < expected) bytes = bytes.slice(Number(expected - start))
    }
    // Track queued bytes separately from bytes already parsed by xterm.
    this.receivedOffset = event.offset
    const generation = this.generation
    this.terminal.write(bytes, () => {
      if (this.disposed) return
      // Advance even if disconnected: these bytes are now in this emulator.
      this.offset = event.offset!
      if (client !== this.client || event.stream !== this.stream || generation !== this.generation) return
      client.ack(this.stream!, event.sequence!)
      if (event.type === 'screen') {
        this.waitingForScreen = false
        this.restoredScreen = true
        this.state({ phase: 'live' })
        this.terminal.options.disableStdin = this.readOnly || !this.running()
        this.scheduleFit()
      } else if (!this.waitingForScreen) {
        clearTimeout(this.recoveryTimer)
        this.resumeAttempted = false
        this.screenAttempted = false
      }
    })
  }
  dispose() {
    this.disposed = true
    this.unsubscribe?.()
    clearTimeout(this.resizeTimer)
    this.observer.disconnect()
    this.themeObserver.disconnect()
    this.stopInput()
    if (this.client)
      void this.client
        .request('detach', { paneId: this.paneId })
        .catch(() => {})
    this.client = null
    this.terminal.dispose()
  }
}
