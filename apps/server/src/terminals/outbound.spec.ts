import { WebSocket } from 'ws';
import { TerminalOutbound } from './outbound.js';

describe('terminal output scheduling', () => {
  afterEach(() => vi.useRealTimers());
  function fixture() {
    const sent: Record<string, unknown>[] = [];
    const socket = {
      readyState: WebSocket.OPEN,
      bufferedAmount: 300 * 1024,
      send: (data: string) => sent.push(JSON.parse(data)),
      close: vi.fn(),
    };
    return {
      socket,
      sent,
      output: new TerminalOutbound(socket as unknown as WebSocket, () => true),
    };
  }
  it('retains stream order under backpressure while control responses remain responsive', () => {
    vi.useFakeTimers();
    const { socket, sent, output } = fixture();
    output.send({ type: 'output', stream: 'a', sequence: '1' });
    output.send({ type: 'gap', stream: 'a' });
    output.send({ type: 'result', id: 'request' });
    expect(sent.map((frame) => frame.type)).toEqual(['result']);
    expect(socket.close).not.toHaveBeenCalled();
    socket.bufferedAmount = 0;
    vi.advanceTimersByTime(8);
    expect(sent.map((frame) => frame.type)).toEqual([
      'result',
      'output',
      'gap',
    ]);
    output.close();
  });
  it('releases queued output and scheduled drains when the socket closes', () => {
    vi.useFakeTimers();
    const { socket, sent, output } = fixture();
    output.send({ type: 'output', stream: 'a' });
    output.close();
    socket.bufferedAmount = 0;
    vi.runAllTimers();
    expect(sent).toEqual([]);
  });
});
