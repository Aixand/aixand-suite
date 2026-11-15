import { expect, test, type Page, type WebSocketRoute } from './fixtures'
import AxeBuilder from '@axe-core/playwright'

type Operation = { id: string; op: string; args: Record<string, unknown> }
declare global {
  interface Window {
    voiceFixture: {
      streams: MediaStream[]
      peers: RTCPeerConnection[]
      answer: (sdp: string) => Promise<string>
    }
  }
}

async function connect(page: Page, options: { deny?: boolean; unavailable?: boolean; holdStart?: boolean } = {}) {
  const operations: Operation[] = []
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.addInitScript(({ deny }) => {
    const streams: MediaStream[] = [], peers: RTCPeerConnection[] = []
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      if (deny) throw new DOMException('Denied by fixture', 'NotAllowedError')
      const stream = await capture(constraints)
      streams.push(stream)
      return stream
    }
    window.voiceFixture = { streams, peers, answer: async (sdp) => {
      const peer = new RTCPeerConnection()
      peers.push(peer)
      await peer.setRemoteDescription({ type: 'offer', sdp })
      await peer.setLocalDescription(await peer.createAnswer())
      if (peer.iceGatheringState !== 'complete') await new Promise<void>((resolve) => {
        peer.addEventListener('icegatheringstatechange', () => { if (peer.iceGatheringState === 'complete') resolve() })
      })
      return peer.localDescription!.sdp
    } }
  }, { deny: options.deny })
  let chat: Record<string, unknown> = {}
  let socket: WebSocketRoute
  let voiceKey = ''
  let held: (() => Promise<void>) | undefined
  const send = (message: unknown) => socket.send(JSON.stringify(message))
  const event = (value: object) => send({ type: 'chat-voice-event', chatId: chat.id, key: voiceKey, event: value })
  await page.routeWebSocket('**/api/carrier/ws', (carrier) => {
    carrier.send(JSON.stringify({ type: 'ready' }))
    carrier.onMessage((raw) => {
      const message = JSON.parse(String(raw)) as Operation
      carrier.send(JSON.stringify({ type: 'result', id: message.id, result: message.op === 'snapshot' ?
        { status: { connected: true, agent_configured: true, providers: ['codex'], version: 1 }, messages: [], counts: {}, total: 0 } :
          message.op === 'directory' ? { sessions: [] } : [] }))
    })
  })
  await page.routeWebSocket('**/api/agents/ws', (connection) => {
    socket = connection
    send({ type: 'ready' })
    socket.onMessage(async (raw) => {
      const message = JSON.parse(String(raw)) as Operation
      operations.push(message)
      if (message.op === 'chat-voice-start') {
        voiceKey = String(message.args.key)
        if (options.unavailable) {
          send({ type: 'error', id: message.id, message: 'Voice is unavailable for this account.' })
          return
        }
        const respond = async () => {
          // Use a real local WebRTC peer and deliver its answer before the RPC response.
          const sdp = await page.evaluate((sdp) => window.voiceFixture.answer(sdp), String(message.args.sdp))
          event({ kind: 'sdp', sdp })
          send({ type: 'result', id: message.id, result: { key: voiceKey } })
        }
        if (options.holdStart) held = respond
        else await respond()
        return
      }
      if (message.op === 'chat-voice-stop') {
        event({ kind: 'closed', reason: 'Voice ended.' })
        send({ type: 'result', id: message.id, result: { stopped: true } })
        return
      }
      let result: unknown = {}
      if (message.op === 'mcp-catalog') result = { servers: [] }
      if (message.op === 'mcp-preview') result = { digest: '', project: null, states: [], selection: {} }
      if (message.op === 'catalog') result = { profiles: [
        { id: 'codex/work', provider: 'codex', profile: 'work', auth: 'personal', active_runs: 0 },
      ], auths: [], capabilities: [], cwd: '/workspace' }
      if (message.op === 'models') result = []
      if (message.op === 'chat-list') result = chat.id ? [chat] : []
      if (['chat-launches', 'project-list', 'sessions'].includes(message.op)) result = []
      if (message.op === 'chat-create') {
        chat = { id: message.args.key, provider: 'codex', profile: 'work', auth: 'personal', model: null,
          cwd: '/workspace', project: '', mode: 'chat', title: 'Voice conversation', status: 'ready',
          createdAt: 1, updatedAt: 1, revision: 1, items: [], requests: [] }
        result = chat
      }
      if (message.op === 'chat-open') result = chat
      if (message.op === 'chat-send') {
        chat = { ...chat, status: 'completed', revision: 2, title: message.args.text,
          items: [{ id: 'typed-user', type: 'userMessage', text: message.args.text }, { id: 'typed-reply', type: 'agentMessage', text: 'Typed reply still works' }] }
        result = chat
      }
      send({ type: 'result', id: message.id, result })
    })
  })
  await page.goto('/#/chat')
  await expect(page.getByRole('button', { name: 'Start voice chat', exact: true })).toBeEnabled()
  return { operations, errors, event, finish: async () => { await held?.() }, disconnect: () => socket.close() }
}

async function expectMicOff(page: Page) {
  await expect.poll(() => page.evaluate(() => window.voiceFixture.streams.every((stream) =>
    stream.getTracks().every((track) => track.readyState === 'ended')))).toBe(true)
}

test('mic starts a Codex chat, negotiates real WebRTC, shows captions, mutes, and stops', async ({ page }) => {
  const fixture = await connect(page)
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Keep my typed draft')
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click()
  await expect(page.getByText('Voice on · Listening', { exact: true })).toBeVisible()
  await expect(page).toHaveURL(/#\/chat\/[a-f0-9-]+$/)
  await expect(page.getByRole('textbox', { name: 'Instructions', exact: true })).toHaveValue('Keep my typed draft')
  const start = fixture.operations.find((message) => message.op === 'chat-voice-start')!
  expect(start.args.sdp).toMatch(/^v=0/)
  expect(start.args).not.toHaveProperty('threadId')
  fixture.event({ kind: 'transcript', role: 'user', text: 'Explain ', done: false })
  fixture.event({ kind: 'transcript', role: 'user', text: 'the code', done: false })
  fixture.event({ kind: 'transcript', role: 'user', text: 'Explain the code', done: true })
  fixture.event({ kind: 'transcript', role: 'assistant', text: 'Here is how it works.', done: true })
  await expect(page.getByRole('log', { name: 'Voice captions' })).toContainText('Explain the code')
  await expect(page.getByRole('log', { name: 'Voice captions' })).toContainText('Here is how it works.')
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click()
  expect(await page.evaluate(() => window.voiceFixture.streams[0].getAudioTracks()[0].enabled)).toBe(false)
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click()
  expect(await page.evaluate(() => window.voiceFixture.streams[0].getAudioTracks()[0].enabled)).toBe(true)
  await page.getByRole('button', { name: 'Stop voice chat', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Start voice chat', exact: true })).toBeEnabled()
  await expectMicOff(page)
  expect(fixture.operations.filter((message) => message.op === 'chat-create')).toHaveLength(1)
  expect(fixture.operations.find((message) => message.op === 'chat-voice-stop')?.args.key).toBe(start.args.key)
  expect(fixture.errors).toEqual([])
})

test('denied permission creates no chat and leaves typed input usable', async ({ page }) => {
  const fixture = await connect(page, { deny: true })
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Microphone access was denied')
  expect(fixture.operations.some((message) => ['chat-create', 'chat-voice-start'].includes(message.op))).toBe(false)
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Use typing instead')
  await page.getByRole('button', { name: 'Start agent', exact: true }).click()
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('Typed reply still works')
  expect(fixture.errors).toEqual([])
})

test('unavailable account releases the microphone and preserves typed chat', async ({ page }) => {
  const fixture = await connect(page, { unavailable: true })
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click()
  await expect(page.getByRole('alert')).toContainText('Voice is unavailable for this account')
  await expectMicOff(page)
  await expect(page.getByRole('button', { name: 'Start voice chat', exact: true })).toBeEnabled()
  await page.getByRole('textbox', { name: 'Instructions', exact: true }).fill('Still here')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  await expect(page.getByRole('log', { name: 'Conversation messages' })).toContainText('Typed reply still works')
  expect(fixture.errors).toEqual([])
})

test('navigation during startup stops capture and ignores a late answer', async ({ page }) => {
  const fixture = await connect(page, { holdStart: true })
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click()
  await expect.poll(() => fixture.operations.some((message) => message.op === 'chat-voice-start')).toBe(true)
  await page.getByRole('button', { name: 'New chat', exact: true }).click()
  await expectMicOff(page)
  await expect.poll(() => fixture.operations.some((message) => message.op === 'chat-voice-stop')).toBe(true)
  await fixture.finish()
  await expect(page.getByText('Voice on · Listening', { exact: true })).toHaveCount(0)
  expect(fixture.errors).toEqual([])
})

test('gateway disconnect stops capture without reopening voice', async ({ page }) => {
  const fixture = await connect(page)
  await page.getByRole('button', { name: 'Start voice chat', exact: true }).click()
  await expect(page.getByText('Voice on · Listening', { exact: true })).toBeVisible()
  fixture.disconnect()
  await expectMicOff(page)
  await expect(page.getByRole('region', { name: 'Voice chat', exact: true }).getByRole('alert')).toContainText('Microphone is off')
  expect(fixture.operations.filter((message) => message.op === 'chat-voice-start')).toHaveLength(1)
  expect(fixture.errors).toEqual([])
})

for (const theme of ['light', 'dark']) {
  test(`voice controls fit mobile and are accessible in ${theme} mode`, async ({ page }) => {
    await page.addInitScript((value) => localStorage.setItem('aixand.appearance', value), theme)
    await page.setViewportSize({ width: 390, height: 844 })
    const fixture = await connect(page)
    await page.getByRole('button', { name: 'Start voice chat', exact: true }).click()
    await expect(page.getByText('Voice on · Listening', { exact: true })).toBeVisible()
    fixture.event({ kind: 'transcript', role: 'user', text: 'Walk me through this project.', done: true })
    fixture.event({ kind: 'transcript', role: 'assistant', text: 'Let’s start with the chat interface.', done: true })
    expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.screenshot({ path: `artifacts/voice/${theme}-mobile.png`, fullPage: true })
    await page.getByRole('button', { name: 'Stop voice chat', exact: true }).click()
    await expectMicOff(page)
  })
}
