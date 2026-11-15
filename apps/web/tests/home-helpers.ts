import type { Page } from './fixtures'

// Chat composer fixtures also render Home's background overview when testing parity.
export async function mockHomeOverview(page: Page) {
  await page.route('**/api/auth/onboarding/status', route => route.fulfill({ json: { needed: false } }))
  await page.routeWebSocket('**/api/terminals/ws', socket => {
    socket.send(JSON.stringify({ type: 'ready' }))
    socket.onMessage(raw => {
      const command = JSON.parse(String(raw))
      if (command.op === 'ack') return
      socket.send(JSON.stringify({ type: 'result', id: command.id,
        result: command.op === 'list' ? { items: [], next_cursor: null, total: 0 } : {} }))
    })
  })
}
