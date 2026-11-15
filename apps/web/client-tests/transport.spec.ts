import { test, expect } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.route('**/__client_test', route => route.fulfill({ contentType: 'text/html', body: '<html><body>Client transport fixture</body></html>' }))
  await page.addInitScript(() => {
    const host = window as any
    host.__AIXAND_CLIENT__ = true; host.__AIXAND_CONNECTION__ = 7
    host.calls = []; host.channels = []
    host.__TAURI__ = { core: {
      Channel: class { onmessage = (_value: unknown) => {}; constructor() { host.channels.push(this) } },
      invoke: async (command: string, args: any) => {
        host.calls.push({ command, args })
        if (command === 'client_request') return { status: 200, headers: [['content-type', 'application/json']], body: [...new TextEncoder().encode('{"ok":true}')] }
        if (command === 'client_socket_open') setTimeout(() => args.events.onmessage({ type: 'open' }), 0)
      },
    } }
  })
  await page.goto('/__client_test')
})

test('routes API requests through the selected native connection', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { workspaceFetch } = await import('/src/auth/transport.ts' as string)
    const response = await workspaceFetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'csrf' }, body: '{"password":"fixture"}' })
    return { body: await response.json(), call: (window as any).calls[0] }
  })
  expect(result.body).toEqual({ ok: true })
  expect(result.call.command).toBe('client_request')
  expect(result.call.args.connection).toBe(7)
  expect(result.call.args.request.headers).toContainEqual(['x-csrf-token', 'csrf'])
  expect(result.call.args.request.body).toEqual([...new TextEncoder().encode('{"password":"fixture"}')])
})

test('preserves socket events, send order and buffered amount', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { workspaceSocket } = await import('/src/auth/transport.ts' as string)
    const socket = workspaceSocket('/api/terminals/ws')
    const events: string[] = []
    socket.onmessage = (event: MessageEvent) => events.push(event.data)
    await new Promise<void>(resolve => socket.onopen = () => resolve())
    socket.send('first'); socket.send('second')
    ;(window as any).channels[0].onmessage({ type: 'message', data: 'terminal output' })
    await new Promise(resolve => setTimeout(resolve, 30))
    const amount = socket.bufferedAmount
    const closed = new Promise<number>(resolve => socket.onclose = (event: CloseEvent) => resolve(event.code))
    socket.close()
    return { events, amount, code: await closed, calls: (window as any).calls.map((call: any) => ({ command: call.command, data: call.args.data, connection: call.args.connection })) }
  })
  expect(result.events).toEqual(['terminal output'])
  expect(result.amount).toBe(0)
  expect(result.code).toBe(1000)
  expect(result.calls.map((row: any) => row.data)).toEqual([undefined, 'first', 'second', null])
  expect(result.calls.every((row: any) => row.connection === 7)).toBe(true)
})

test('browser and Desktop keep same-origin fetch even when Tauri is present', async ({ page }) => {
  await page.evaluate(() => { (window as any).__AIXAND_CLIENT__ = false })
  await page.route('**/api/auth/status', route => route.fulfill({ json: { browser: true } }))
  const result = await page.evaluate(async () => {
    const { workspaceFetch } = await import('/src/auth/transport.ts' as string)
    return { value: await (await workspaceFetch('/api/auth/status')).json(), calls: (window as any).calls }
  })
  expect(result).toEqual({ value: { browser: true }, calls: [] })
})

test('aborted requests do not deliver late results', async ({ page }) => {
  const result = await page.evaluate(async () => {
    const { workspaceFetch } = await import('/src/auth/transport.ts' as string)
    ;(window as any).__TAURI__.core.invoke = () => new Promise(resolve => setTimeout(() => resolve({ status: 200, headers: [], body: [] }), 100))
    const controller = new AbortController()
    const pending = workspaceFetch('/api/auth/status', { signal: controller.signal }).catch((error: Error) => error.name)
    controller.abort()
    return await pending
  })
  expect(result).toBe('AbortError')
})
