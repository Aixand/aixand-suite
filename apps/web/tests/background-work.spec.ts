import { expect, test } from './fixtures'

test('deleted remote work stays manageable while its device is offline and after reconnect', async ({ page }) => {
  let online = false
  let unresolved = true
  const operations: { op: string; args: Record<string, unknown> }[] = []
  await page.routeWebSocket('**/api/carrier/ws', route => { route.send(JSON.stringify({ type: 'ready' })); route.onMessage(() => {}) })
  await page.routeWebSocket('**/api/agents/ws', route => {
    route.send(JSON.stringify({ type: 'ready' }))
    route.onMessage(raw => {
      const message = JSON.parse(String(raw)); operations.push(message)
      let result: unknown = {}
      switch (message.op) {
        case 'catalog': result = { profiles: [], auths: [], capabilities: [], cwd: '/project' }; break
        case 'chat-list': case 'project-list': case 'models': case 'mcp-jobs': result = []; break
        case 'sessions': result = { runs: [] }; break
        case 'mcp-catalog': result = { servers: [] }; break
        case 'spawn-settings-get': result = { defaultMode: 'read-only', revision: 0 }; break
        case 'connect-devices': result = { configured: true, devices: [{ id: 'device', name: 'Laptop', peerId: 'peer', ip: '100.80.1.2', port: 47831,
          os: 'Linux', paired: true, status: online ? 'ready' : 'offline', capabilities: { files: true, codex: true } }] }; break
        case 'connect-activity-check': online = true; break
        case 'connect-activity-stop': unresolved = false; break
        case 'connect-activity-list': result = { activities: unresolved ? [{ id: 'chat:retained', kind: 'chat', title: 'Retained task', deviceId: 'device',
          device: 'Laptop', status: 'uncertain', conversationDeleted: true, chatId: 'retained' }] : [] }; break
      }
      route.send(JSON.stringify({ type: 'result', id: message.id, result }))
    })
  })
  await page.goto('/#/settings?section=devices')
  const section = page.getByRole('region', { name: 'Background work' })
  await expect(section).toContainText('Retained task')
  await expect(section).toContainText('Conversation deleted')
  await expect(section.getByRole('link', { name: 'Open conversation' })).toHaveCount(0)
  await expect(section.getByRole('button', { name: 'Stop work' })).toBeDisabled()
  await section.getByRole('button', { name: 'Check status' }).click()
  await page.reload()
  await expect(section.getByRole('button', { name: 'Stop work' })).toBeEnabled()
  await section.getByRole('button', { name: 'Stop work' }).click()
  await expect(section).toContainText('No unresolved background work.')
  expect(operations.filter(operation => operation.op === 'chat-open')).toHaveLength(0)
})
