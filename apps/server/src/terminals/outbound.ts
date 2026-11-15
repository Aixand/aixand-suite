import { WebSocket } from 'ws';

/** Browser acknowledgements bound bulk production. This queue absorbs short
 * network stalls and reserves writer opportunities for results and recovery. */
export class TerminalOutbound {
  private control: string[] = [];
  private streams: string[] = [];
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private closed = false;
  constructor(
    private readonly socket: WebSocket,
    private readonly allowed: () => boolean,
  ) {}
  send(message: unknown) {
    if (
      this.closed ||
      this.socket.readyState !== WebSocket.OPEN ||
      !this.allowed()
    )
      return;
    const data = JSON.stringify(message);
    const bytes = Buffer.byteLength(data);
    if (this.bytes + this.socket.bufferedAmount + bytes > 8 * 1024 * 1024) {
      this.socket.close(1013, 'Terminal connection exceeded its output budget');
      this.close();
      return;
    }
    const stream = typeof (message as { stream?: unknown }).stream === 'string';
    (stream ? this.streams : this.control).push(data);
    this.bytes += bytes;
    this.drain();
  }
  private drain() {
    clearTimeout(this.timer);
    if (
      this.closed ||
      this.socket.readyState !== WebSocket.OPEN ||
      !this.allowed()
    ) {
      this.close();
      return;
    }
    while (this.control.length || this.streams.length) {
      if (!this.control.length && this.socket.bufferedAmount >= 256 * 1024)
        break;
      const data = this.control.shift() ?? this.streams.shift()!;
      this.bytes -= Buffer.byteLength(data);
      this.socket.send(data);
    }
    if (this.control.length || this.streams.length)
      this.timer = setTimeout(() => this.drain(), 8);
  }
  close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.control = [];
    this.streams = [];
    this.bytes = 0;
  }
}
