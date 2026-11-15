import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import {
  TerminalConnection,
  TerminalRequestError,
  decodeBytes,
  encodeBytes,
} from './connection'
import type { Session, TerminalEvent } from './connection'

export type PaneState = {
  phase: 'offline' | 'connecting' | 'recovering' | 'live' | 'gap' | 'error'
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
  private remoteResizeTimer?: ReturnType<typeof setTimeout>
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
  private backendPaused = false
  private retryTimer?: ReturnType<typeof setTimeout>
  private attachmentRetries = 0
  private retryScreen: boolean | null = null
  private blockedSize = ''
  private resizeRetries = 0
  private suspensionTimer?: ReturnType<typeof setTimeout>
  private suspended = false
  private inputNotice = ''
  private visibilityChanged = () => this.updateVisibility()

  constructor(
    private host: HTMLElement,
    private paneId: string,
    private session: Session,
    private change: (state: PaneState) => void,
    private readOnly = false
  ) {
    this.terminal = new Terminal({
      cursorBlink: !readOnly,
      disableStdin: true,
      scrollback: 5000,
      overviewRuler: {
        width:
          parseFloat(
            getComputedStyle(host).getPropertyValue('--ax-scrollbar-size')
          ) || 4,
      },
      fontFamily: 'ui-monospace, monospace',
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
    if (readOnly && this.terminal.textarea)
      this.terminal.textarea.readOnly = true
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
    // Changing the family after loading makes xterm remeasure its cells.
    void document.fonts
      .load('13px "JetBrainsMono Nerd Font Mono"')
      .then(() => {
        if (this.disposed) return
        this.terminal.options.fontFamily =
          '"JetBrainsMono Nerd Font Mono", ui-monospace, monospace'
        this.scheduleFit()
      })
      .catch(() => {})
    document.addEventListener('visibilitychange', this.visibilityChanged)
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
      state.notice ??= this.inputNotice || undefined
      if (this.restoredScreen && !state.notice)
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
      this.readOnly ||
      this.backendPaused ||
      this.phase !== 'live' ||
      !this.running()
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
    this.updateVisibility()
  }
  private updateVisibility() {
    clearTimeout(this.suspensionTimer)
    if (this.visible && document.visibilityState !== 'hidden') {
      if (this.suspended) {
        this.suspended = false
        void this.attach(false)
      } else this.scheduleFit()
    } else {
      // Keep quick tab switches local. Sustained inactivity releases the output
      // interest while preserving this emulator and its parsed-byte checkpoint.
      this.suspensionTimer = setTimeout(() => {
        if (this.disposed) return
        this.suspended = true
        this.stopInput()
        this.stream = null
        void this.client
          ?.request('detach', { paneId: this.paneId })
          .catch(() => {})
      }, 2000)
    }
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
    this.backendPaused = false
    this.retryScreen = null
    this.attachmentRetries = 0
    clearTimeout(this.retryTimer)
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
    if (!client || this.disposed || this.suspended) return
    this.stopInput()
    if (!automatic) {
      this.resumeAttempted = false
      this.screenAttempted = false
      this.attachmentRetries = 0
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
      this.retryScreen = null
      this.attachmentRetries = 0
      if (screen) {
        // An accepted attachment is not yet a restored display. Keep input
        // paused until xterm has parsed the authoritative screen.
        this.screenTimer = setTimeout(() => {
          if (client === this.client && generation === this.generation) {
            this.stream = null
            this.fail(
              new Error('The current screen did not arrive. Please try again.'),
              true
            )
          }
        }, 10_000)
      } else {
        this.state({ phase: 'live' })
        this.terminal.options.disableStdin =
          this.readOnly || this.backendPaused || !this.running()
        this.scheduleFit()
      }
    } catch (cause) {
      if (this.client !== client || generation !== this.generation) return
      if (
        cause instanceof TerminalRequestError &&
        cause.retryable &&
        this.attachmentRetries < 5
      ) {
        this.retryScreen = screen
        this.state({
          phase: 'recovering',
          notice: 'Reconnecting… typing paused.',
        })
        this.attachmentRetries++
        clearTimeout(this.retryTimer)
        this.retryTimer = setTimeout(
          () => {
            if (
              !this.disposed &&
              this.client === client &&
              this.retryScreen !== null
            )
              void this.attach(this.retryScreen, true)
          },
          Math.min(200 * 2 ** (this.attachmentRetries - 1), 2000)
        )
      } else this.fail(cause, screen)
    }
  }
  private fail(cause: unknown, screen = false) {
    this.stopInput()
    const message =
      cause instanceof Error ? cause.message : 'Terminal operation failed.'
    this.state({
      phase: screen ? 'gap' : 'error',
      message: screen
        ? `Could not restore the current screen. ${message}`
        : message,
    })
  }
  private backendState() {
    if (!this.client || this.disposed) return
    if (
      this.client.backend === 'recovering' ||
      this.client.backend === 'connecting'
    ) {
      this.backendPaused = true
      // Do not invalidate the output generation: queued xterm writes must still
      // acknowledge their bytes while the SDK restores its physical connection.
      this.terminal.options.disableStdin = true
      const hadInput = this.queueBytes > 0
      this.queue = []
      this.queueBytes = 0
      if (hadInput && !this.inputNotice)
        this.inputNotice = 'Queued typing was not sent.'
      this.state({
        phase: 'recovering',
        notice: this.inputNotice
          ? `Reconnecting… typing paused. ${this.inputNotice}`
          : 'Reconnecting… typing paused.',
      })
    } else if (
      this.client.backend === 'connected' &&
      (this.backendPaused || this.retryScreen !== null)
    ) {
      this.backendPaused = false
      this.blockedSize = ''
      this.resizeRetries = 0
      if (this.retryScreen !== null || !this.stream) {
        clearTimeout(this.retryTimer)
        void this.attach(
          this.retryScreen ?? (this.readOnly || this.historyGap),
          true
        )
      } else if (this.stream && !this.waitingForScreen) {
        this.state({ phase: 'live' })
        this.terminal.options.disableStdin = this.readOnly || !this.running()
        this.scheduleFit()
      }
    } else if (this.client.backend === 'failed') {
      this.fail(
        new Error(
          'The terminal backend could not reconnect. Retry the connection.'
        )
      )
    }
  }
  private recover(screen: boolean, message?: string) {
    if (screen) this.historyGap = true
    const snapshot = screen || this.readOnly || this.waitingForScreen
    if (snapshot ? this.screenAttempted : this.resumeAttempted) {
      this.stream = null
      this.fail(
        new Error(
          message ?? 'Terminal output is still interrupted. Please try again.'
        ),
        snapshot
      )
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
    clearTimeout(this.remoteResizeTimer)
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
      // Fit the browser promptly; debounce PTY changes until layout settles.
      this.remoteResizeTimer = setTimeout(() => {
        if (this.disposed || !this.visible) return
        const size = `${columns}:${rows}`
        if (
          size === this.lastSize ||
          size === this.blockedSize ||
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
            if (this.client === client && generation === this.generation) {
              this.lastSize = size
              this.resizeRetries = 0
              if (this.blockedSize) {
                this.blockedSize = ''
                this.state({ phase: 'live' })
              }
            }
          })
          .catch((cause) => {
            if (this.client !== client || generation !== this.generation) return
            if (client.backend !== 'connected') this.backendState()
            else if (
              !(cause instanceof TerminalRequestError) ||
              !cause.retryable ||
              ++this.resizeRetries >= 5
            ) {
              this.blockedSize = size
              this.state({
                phase: 'live',
                notice: `Could not resize the terminal. ${cause instanceof Error ? cause.message : ''}`,
              })
            }
          })
          .finally(() => {
            this.resizing = false
            // A slow acknowledgement may arrive after another layout change.
            // Coalesce those changes and send the latest size next.
            if (!this.disposed && this.phase === 'live') {
              if (this.resizeRetries)
                this.resizeTimer = setTimeout(
                  () => this.scheduleFit(),
                  Math.min(200 * 2 ** this.resizeRetries, 2000)
                )
              else this.scheduleFit()
            }
          })
      }, 100)
    }, 32)
  }
  private input(bytes: Uint8Array) {
    if (this.readOnly || !this.client || this.terminal.options.disableStdin)
      return
    if (this.queueBytes + bytes.length > 128 * 1024) {
      this.state({
        phase: 'live',
        notice: 'Input queue is full. The new input was not sent.',
      })
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
      if (generation === this.generation) {
        this.queue = []
        this.queueBytes = 0
        this.inputNotice =
          cause instanceof Error ? cause.message : 'Input could not be sent.'
        if (client && client.backend !== 'connected') this.backendState()
        else this.state({ phase: 'live', notice: this.inputNotice })
      }
    } finally {
      this.sending = false
      if (this.queue.length && !this.disposed) void this.flush()
    }
  }
  private receive(event: TerminalEvent, client: TerminalConnection) {
    if (event.type === 'backend-state' && client === this.client) {
      this.backendState()
      return
    }
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
        // With pipelined delivery, the original may still be queued in xterm.
        // A duplicate cannot acknowledge that original before parsing finishes.
        const stream = this.stream
        this.terminal.write('', () => {
          if (
            !this.disposed &&
            client === this.client &&
            stream === this.stream
          )
            client.ack(stream, event.sequence!)
        })
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
      if (
        client !== this.client ||
        event.stream !== this.stream ||
        generation !== this.generation
      )
        return
      client.ack(this.stream!, event.sequence!)
      if (event.type === 'screen') {
        this.waitingForScreen = false
        this.restoredScreen = true
        this.state({
          phase: this.backendPaused ? 'recovering' : 'live',
          notice: this.backendPaused
            ? 'Reconnecting… typing paused.'
            : undefined,
        })
        this.terminal.options.disableStdin =
          this.readOnly || this.backendPaused || !this.running()
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
    clearTimeout(this.remoteResizeTimer)
    clearTimeout(this.retryTimer)
    clearTimeout(this.suspensionTimer)
    document.removeEventListener('visibilitychange', this.visibilityChanged)
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
