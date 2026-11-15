// Real browser, local speech, managed SDKs, isolated Undercurrent, offline Codex fixture.
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve, dirname, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { chromium, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { buildTestServer, testAuthEnvironment, authenticateTestPage } from './isolated-test-server.mjs'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..'), server = resolve(web, '../server')
const python = resolve(web, '../../services/vox/.venv/bin/python')
const binaries = process.env.UNDERCURRENT_BIN_DIR ?? resolve(web, '../../../undercurrent/target/debug')
const work = await mkdtemp(resolve(tmpdir(), 'aixand-vox-live-'))
const wakeOnly = process.env.AIXAND_TEST_VOX_WAKE === '1'
const interruptOnly = process.env.AIXAND_TEST_VOX_INTERRUPT === '1'
const env = { ...process.env,
  PATH: [dirname(python), binaries, process.env.PATH].join(delimiter),
  PYTHONPATH: [resolve(web, '../../../manager-suites/agent-manager'), resolve(web, '../../../undercurrent/python/src')].join(delimiter),
  UNDERCURRENT_HOME: resolve(work, 'runtime'), UNDERCURRENT_PYTHON_BRIDGE: resolve(binaries, 'uc-python-bridge'),
  VOX_PYTHON: python, VOX_STATE_DIR: resolve(work, 'vox'), AGENTS_PYTHON: python,
  AGENTS_STATE_DIR: resolve(work, 'chats'), AGENTS_SCRATCH_DIR: resolve(work, 'scratch'), AGENTS_CWD: work,
  CARRIER_URL: 'http://127.0.0.1:1', CARRIER_AUTO_PROVISION: '0', CARRIER_STATE_DIR: resolve(work, 'carrier'),
  OMP_NUM_THREADS: '2',
}
const children = [], logs = []
let browser, failed = false
function start(command, args, cwd, extra = {}) {
  const child = spawn(command, args, { cwd, env: { ...env, ...testAuthEnvironment(), ...extra }, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output = (output + chunk).slice(-12000) })
  children.push(child); logs.push(() => output)
  return child
}
async function port() {
  const socket = createServer()
  await new Promise((ready) => socket.listen(0, '127.0.0.1', ready))
  const value = socket.address().port
  await new Promise((done) => socket.close(done)); return value
}
async function ready(url) {
  await expect.poll(async () => { try { return (await fetch(url)).ok } catch { return false } }, { timeout: 30000 }).toBe(true)
}
try {
  const fixture = JSON.parse(execFileSync(python, [resolve(server, 'agent-bridge/tests/fixture.py'), work], { env, encoding: 'utf8' }))
  env.AGENT_MANAGER_HOME = fixture.home; env.AGENT_MANAGER_CONFIG = fixture.config
  const workAuth = await readFile(resolve(work, 'manager/codex/agents/work/auth.json'), 'utf8')
  const reviewAuth = await readFile(resolve(work, 'manager/codex/agents/review/auth.json'), 'utf8')
  await writeFile(resolve(work, 'manager/codex/fixture-budgets.json'), JSON.stringify({ [workAuth]: 10, [reviewAuth]: 80 }))
  const provider = await readFile(resolve(server, 'agent-bridge/tests/app_server_provider.py'), 'utf8')
  await writeFile(resolve(work, 'offline-provider'), provider.replace('#!/usr/bin/env python3', `#!${python}`), { mode: 0o700 })
  const wav = resolve(work, 'microphone.wav')
  execFileSync(python, ['-c', `
import numpy as np, soundfile as sf, sys
from pipecat.services.kokoro.tts import KokoroTTSService
tts=KokoroTTSService(settings=KokoroTTSService.Settings(voice='af_heart'))
phrases=[('Hey Vox',12),('Vox mute',10),('Vox unmute',4),('Vox end',6),('Hey Vox',10),('Vox go offline',8)] if sys.argv[2]=='wake' else [('Check the backend.',.55),('Actually include the frontend as well.',35)] if sys.argv[2]=='interrupt' else [('List my projects.',35)]
rate=24000; chunks=[np.zeros(rate*(12 if sys.argv[2] in ('wake','interrupt') else 8))]
for phrase,pause in phrases:
    audio,rate=tts._kokoro.create(phrase, voice='af_heart', speed=1.0, lang='en-us')
    chunks.extend([audio,np.zeros(int(rate*pause))])
sf.write(sys.argv[1],np.concatenate(chunks),rate)
`, wav, wakeOnly ? 'wake' : interruptOnly ? 'interrupt' : 'call'], { env, cwd: resolve(web, '../../services/vox'), timeout: 90000, stdio: 'pipe' })
  start(resolve(binaries, 'uc-daemon'), [], work)
  await expect.poll(() => spawnSync(resolve(binaries, 'uc'), ['daemon', 'status'], { env, timeout: 2000 }).status, { timeout: 20000 }).toBe(0)
  const apiPort = await port(), webPort = await port(), origin = `http://127.0.0.1:${webPort}`
  const main = buildTestServer(server, work)
  start(process.execPath, [main], server, { HOST: '127.0.0.1', PORT: String(apiPort), CORS_ORIGINS: origin })
  await ready(`http://127.0.0.1:${apiPort}/api/health`)
  const webDist = resolve(work, 'web-dist')
  execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build', '--outDir', webDist], { cwd: web, env, stdio: 'pipe' })
  start(process.execPath, ['node_modules/vite/bin/vite.js', 'preview', '--outDir', webDist, '--host', '127.0.0.1', '--port', String(webPort), '--strictPort'], web,
    { AIXAND_SERVER_URL: `http://127.0.0.1:${apiPort}` })
  await ready(origin)
  browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`] })
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, permissions: ['microphone'], hasTouch: true })
  await context.addInitScript(() => {
    const NativePeer = window.RTCPeerConnection
    const NativeAudio = window.Audio
    window.__voxTestPeers = []
    window.__voxTestAudio = []
    window.__voxTestStreams = []
    window.__voxTestStatsCalls = 0
    window.__voxTestWakeDiagnostics = []
    window.__voxTestDebugChanges = []
    window.__voxTestEvents = []
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args)
        if (new URL(this.url).pathname === '/api/vox/ws') this.addEventListener('message', (event) => {
          const message = JSON.parse(event.data)
          if (message.type === 'event') window.__voxTestEvents.push(message.event)
          if (message.type === 'wake-event' && message.event.kind === 'diagnostic') {
            window.__voxTestWakeDiagnostics.push(message.event)
            window.__voxTestWakeDiagnostics = window.__voxTestWakeDiagnostics.slice(-100)
          }
          if (typeof message.result?.debug === 'boolean') window.__voxTestDebugChanges.push(message.result.debug)
        })
      }
    }
    const capture = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices)
    navigator.mediaDevices.getUserMedia = async (...args) => {
      const stream = await capture(...args)
      window.__voxTestStreams.push(stream)
      return stream
    }
    const clone = MediaStream.prototype.clone
    MediaStream.prototype.clone = function () {
      const stream = clone.call(this)
      window.__voxTestStreams.push(stream)
      return stream
    }
    window.RTCPeerConnection = class extends NativePeer {
      constructor(...args) { super(...args); window.__voxTestPeers.push(this) }
      getStats(...args) { window.__voxTestStatsCalls++; return super.getStats(...args) }
    }
    window.Audio = function (...args) {
      const audio = new NativeAudio(...args)
      window.__voxTestAudio.push(audio)
      return audio
    }
    window.Audio.prototype = NativeAudio.prototype
  })
  const page = await context.newPage(), errors = [], diagnosticLogs = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => { if (message.text().startsWith('[Vox]')) diagnosticLogs.push(message.text()) })
  await authenticateTestPage(page, origin)
  await page.goto(origin + '/#/chat')
  await expect(page.getByRole('button', { name: 'New project', exact: true })).toBeEnabled()
  await page.getByRole('button', { name: 'New project', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'New project', exact: true })
  await dialog.getByLabel('Project name').fill('Studio website')
  await dialog.getByLabel('Project path').fill(work)
  await dialog.getByRole('button', { name: 'Create project', exact: true }).click()
  await expect(dialog).toHaveCount(0)
  const head = page.getByRole('button', { name: 'Vox assistant', exact: true })
  const panel = page.getByRole('complementary', { name: 'Vox assistant' })
  await expect(head).toBeVisible()
  async function expectAt(x, y) {
    await expect.poll(async () => {
      const box = await head.boundingBox()
      return Math.max(Math.abs(box.x - x), Math.abs(box.y - y))
    }).toBeLessThan(1)
  }
  async function dragHead(x, y) {
    const box = await head.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, y, { steps: 12 })
    await page.mouse.up()
  }
  await expectAt(1368, 1028)
  expect(await page.locator('.topbar').getByRole('button', { name: 'Vox assistant', exact: true }).count()).toBe(0)
  await dragHead(80, 350)
  await expectAt(16, 322)
  await expect(panel).toHaveCount(0)
  await dragHead(700, 40)
  await expectAt(672, 16)
  await expect(panel).toHaveCount(0)
  await dragHead(700, 1080)
  await expectAt(672, 1028)
  await dragHead(1380, 500)
  await expectAt(1368, 472)
  const retained = await page.evaluate(() => localStorage.getItem('aixand.vox.position'))
  await page.reload()
  await expectAt(1368, 472)
  expect(await page.evaluate(() => localStorage.getItem('aixand.vox.position'))).toBe(retained)
  await head.focus()
  await page.keyboard.press('Home')
  await expectAt(1368, 1028)
  await head.click()
  if (wakeOnly) {
    await expect(panel.getByText('Voice diagnostics', { exact: true })).toHaveCount(0)
    await panel.getByRole('switch', { name: 'Auto-call · Hey Vox', exact: true }).check()
    await expect(head).toHaveAttribute('data-wake', 'true', { timeout: 60000 })
    await expect.poll(() => page.evaluate(() => window.__voxTestPeers.some((peer) => peer.connectionState === 'connected')), { timeout: 60000 }).toBe(true)
    await page.waitForTimeout(5500)
    expect(await page.evaluate(() => window.__voxTestStatsCalls)).toBe(0)
    expect(await page.evaluate(() => window.__voxTestWakeDiagnostics)).toEqual([])
    expect(diagnosticLogs).toEqual([])
    async function settingsPage() {
      if (await panel.count()) await panel.getByRole('button', { name: 'Hide Vox', exact: true }).click()
      await page.getByRole('button', { name: 'Profile menu', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
      await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
      return page.getByRole('switch', { name: 'Debug mode', exact: true })
    }
    await (await settingsPage()).check()
    await expect.poll(() => page.evaluate(() => window.__voxTestDebugChanges.at(-1))).toBe(true)
    const threadsFile = resolve(work, 'manager/codex/agents/work/fixture-threads.json')
    let before = {}
    try { before = JSON.parse(await readFile(threadsFile, 'utf8')) } catch {}
    expect(Object.keys(before)).toHaveLength(0)
    await expect(head).toHaveAttribute('data-active', 'true', { timeout: 60000 })
    await expect(head).toHaveAttribute('data-listening', 'true', { timeout: 60000 })
    await expect(panel).toHaveCount(0)
    await expect(head).not.toHaveAttribute('data-listening', 'true', { timeout: 30000 })
    await head.click()
    await expect(panel.getByRole('button', { name: 'Unmute', exact: true })).toBeVisible()
    expect(await page.evaluate(() => window.__voxTestStreams[0].getAudioTracks()[0].enabled)).toBe(true)
    expect(await page.evaluate(() => window.__voxTestStreams[1].getAudioTracks()[0].enabled)).toBe(false)
    await (await settingsPage()).uncheck()
    await expect.poll(() => page.evaluate(() => window.__voxTestDebugChanges.at(-1))).toBe(false)
    const paused = await page.evaluate(() => ({ stats: window.__voxTestStatsCalls, diagnostics: window.__voxTestWakeDiagnostics.length }))
    const pausedLogs = diagnosticLogs.length
    await page.waitForTimeout(5500)
    expect(await page.evaluate(() => ({ stats: window.__voxTestStatsCalls, diagnostics: window.__voxTestWakeDiagnostics.length }))).toEqual(paused)
    expect(diagnosticLogs.length).toBe(pausedLogs)
    expect(await page.evaluate(() => window.aixandVoxDiagnostics)).toBeUndefined()
    await page.getByRole('switch', { name: 'Debug mode', exact: true }).check()
    await expect.poll(() => page.evaluate(() => window.__voxTestDebugChanges.at(-1))).toBe(true)
    await head.click()
    await expect(panel.getByRole('button', { name: 'Mute', exact: true })).toBeVisible({ timeout: 30000 })
    await expect(head).toHaveAttribute('data-listening', 'true')
    await expect(head).not.toHaveAttribute('data-active', 'true', { timeout: 30000 })
    await expect(head).toHaveAttribute('data-wake', 'true')
    await expect(head).toHaveAttribute('data-active', 'true', { timeout: 30000 })
    await expect(head).toHaveAttribute('data-listening', 'true', { timeout: 60000 })
    await expect(head).not.toHaveAttribute('data-active', 'true', { timeout: 30000 })
    await expect(head).not.toHaveAttribute('data-wake', 'true')
    await expect.poll(() => page.evaluate(() => window.__voxTestStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')))).toBe(true)
    const threads = JSON.parse(await readFile(threadsFile, 'utf8'))
    expect(Object.values(threads)).toHaveLength(2)
    expect(Object.values(threads).every((thread) => thread.turns.length === 0)).toBe(true)
    const report = await page.evaluate(() => JSON.parse(window.aixandVoxDiagnostics.export()))
    expect(report.events.some((event) => event.event === 'wake-server-model-ready' && event.details.configurationVersion === 'vox-wake-english-v2')).toBe(true)
    expect(report.events.some((event) => event.event === 'wake-server-first-audio')).toBe(true)
    expect(report.events.some((event) => event.event === 'wake-server-audio' && event.details.framesReceived > 0 && event.details.inputRms > 0)).toBe(true)
    expect(report.events.some((event) => event.event === 'wake-keyword-detected' && event.details.action === 'wake')).toBe(true)
    expect(report.events.some((event) => event.event === 'wake-auto-call-triggered')).toBe(true)
    expect(report.snapshot.wakeStatus).toBe('off')
    expect(report.snapshot.wakeTracks).toEqual([])
    expect(diagnosticLogs.some((entry) => entry.includes('wake-server-audio'))).toBe(true)
    expect(JSON.stringify(report)).not.toContain('Studio website')
    expect(JSON.stringify(report)).not.toContain('v=0')
    function checkMetadata(value) {
      if (!value || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        expect(['sdp', 'deviceId', 'groupId', 'auth', 'token', 'text', 'sessionId', 'owner', 'audio'].includes(key)).toBe(false)
        checkMetadata(child)
      }
    }
    checkMetadata(report)
    await head.click()
    await panel.getByText('Voice diagnostics', { exact: true }).click()
    await context.grantPermissions(['microphone', 'clipboard-read', 'clipboard-write'])
    await panel.getByRole('button', { name: 'Copy diagnostics', exact: true }).click()
    await expect(panel.getByText('Copied', { exact: true })).toBeVisible()
    expect(JSON.parse(await page.evaluate(() => navigator.clipboard.readText())).version).toBe('vox-diagnostics-v1')
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('Clipboard denied') } } }) })
    await panel.getByRole('button', { name: 'Copy diagnostics', exact: true }).click()
    const fallback = panel.getByRole('textbox', { name: 'Vox diagnostics report', exact: true })
    await expect(fallback).toBeVisible()
    expect(JSON.parse(await fallback.inputValue()).version).toBe('vox-diagnostics-v1')
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Microphone blocked for diagnostics test', 'NotAllowedError') } })
    await panel.getByRole('switch', { name: 'Auto-call · Hey Vox', exact: true }).click()
    await expect(panel.getByRole('switch', { name: 'Auto-call · Hey Vox', exact: true })).not.toBeChecked()
    await expect(panel.getByRole('alert')).toContainText('Microphone blocked for diagnostics test')
    expect(await page.evaluate(() => JSON.parse(window.aixandVoxDiagnostics.export()).events.some((event) => event.event === 'wake-start-failed' && event.details.name === 'NotAllowedError'))).toBe(true)
    expect(errors).toEqual([])
    console.log('PASS: real Hey Vox and call controls, Settings debug toggle during a muted call, zero diagnostic events/stats/logs while disabled, safe bounded export, clipboard fallback, and microphone denial diagnostics.')
  } else if (interruptOnly) {
    await panel.getByRole('button', { name: 'Start call', exact: true }).click()
    await expect(head).toHaveAttribute('data-listening', 'true', { timeout: 60000 })
    await expect(panel).toHaveCount(0)
    await head.click()
    await panel.getByRole('textbox', { name: 'Message Vox' }).fill('Vox interruption probe')
    await panel.getByRole('button', { name: 'Send to Vox', exact: true }).click()
    await expect(panel.getByRole('log')).toContainText('This reply should stop when you speak.', { timeout: 15000 })
    async function outputEnergy() {
      return page.evaluate(async () => {
        let energy = 0
        for (const peer of window.__voxTestPeers) for (const report of (await peer.getStats()).values())
          if (report.type === 'inbound-rtp' && report.kind === 'audio') energy += report.totalAudioEnergy ?? 0
        return energy
      })
    }
    await expect.poll(outputEnergy, { timeout: 10000 }).toBeGreaterThan(0)
    await expect.poll(() => page.evaluate(() => window.__voxTestEvents.some((event) => event.kind === 'phase' && event.phase === 'listening')),
      { timeout: 60000 }).toBe(true)
    // Allow already-received WebRTC packets to drain, then confirm that old
    // speech is silent while the complete replacement is still being collected.
    await page.waitForTimeout(700)
    const quietEnergy = await outputEnergy()
    await page.waitForTimeout(500)
    expect(await outputEnergy() - quietEnergy).toBeLessThan(0.0005)
    const threadsFile = resolve(work, 'manager/codex/agents/work/fixture-threads.json')
    await expect(panel.getByRole('log')).toContainText(/check the back\s?end/i, { timeout: 60000 })
    await expect(panel.getByRole('log')).toContainText(/include the front\s?end/i, { timeout: 60000 })
    await expect.poll(async () => {
      const threads = JSON.parse(await readFile(threadsFile, 'utf8'))
      return Object.values(threads).filter((thread) => thread.dynamicTools?.length).flatMap((thread) => thread.turns.map((turn) => turn.status))
    }, { timeout: 30000 }).toEqual(['interrupted', 'completed'])
    const threads = JSON.parse(await readFile(threadsFile, 'utf8'))
    const controller = Object.values(threads).find((thread) => thread.dynamicTools?.length)
    expect(controller.turns).toHaveLength(2)
    const instruction = controller.turns[1].items.find((item) => item.type === 'userMessage').content[0].text
    expect(instruction).toMatch(/check the back\s?end/i)
    expect(instruction).toMatch(/include the front\s?end/i)
    expect(instruction).toContain('voice_transcription')
    const events = await page.evaluate(() => window.__voxTestEvents)
    expect(events.some((event) => event.kind === 'phase' && event.phase === 'listening')).toBe(true)
    expect(events.some((event) => event.text?.includes('OBSOLETE VOX OUTPUT'))).toBe(false)
    const drafts = events.filter((event) => event.kind === 'message' && event.role === 'user' && /check the back\s?end/i.test(event.text))
    expect(new Set(drafts.map((event) => event.id)).size).toBe(1)
    await expect(panel.locator('.vox-message--user')).toHaveCount(1)
    await expect(panel.locator('.vox-message--assistant')).toHaveCount(1)
    await expect(panel.getByRole('log')).not.toContainText('OBSOLETE VOX OUTPUT')
    await panel.getByRole('button', { name: 'End call', exact: true }).click()
    await expect(head).not.toHaveAttribute('data-active', 'true')
    await expect.poll(() => page.evaluate(() => window.__voxTestStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')))).toBe(true)
    expect(errors).toEqual([])
    console.log('PASS: real Whisper/WebRTC interruption with playback silenced, paused correction submitted once in the same controller, delayed cancellation confirmation, stale output discarded, one draft bubble, and capture cleanup.')
  } else {
  await expect(panel.getByRole('button', { name: 'Start call', exact: true })).toBeEnabled()
  await panel.getByRole('button', { name: 'Start call', exact: true }).click()
  const updates = page.getByRole('region', { name: 'Vox call updates' })
  await expect(head).toHaveAttribute('data-listening', 'true', { timeout: 60000 })
  await expect(panel).toHaveCount(0)
  const userNotice = updates.getByRole('article', { name: 'Your message' }), replyNotice = updates.getByRole('article', { name: 'Vox reply' })
  await expect(replyNotice).toContainText("Hi, I'm Vox, your virtual assistant. How can I help?")
  await expect.poll(() => page.evaluate(async () => {
    let energy = 0
    for (const peer of window.__voxTestPeers) for (const report of (await peer.getStats()).values())
      if (report.type === 'inbound-rtp' && report.kind === 'audio') energy += report.totalAudioEnergy ?? 0
    return energy
  }), { timeout: 30000 }).toBeGreaterThan(0)
  await expect(userNotice).toContainText('List my projects.', { timeout: 60000 })
  await expect(replyNotice).toContainText('Projects: Studio website', { timeout: 60000 })
  await expect(userNotice).toHaveCount(1)
  await expect(replyNotice).toHaveCount(1)
  await expect(updates).not.toContainText("Hi, I'm Vox")
  await expect(updates.getByRole('button', { name: 'Mute', exact: true })).toHaveCount(0)
  await expect(updates.getByRole('button', { name: 'View conversation', exact: true })).toHaveCount(0)
  await expect(updates.getByText('Listening', { exact: true })).toHaveCount(0)
  expect(await userNotice.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(await replyNotice.evaluate((element) => getComputedStyle(element).backgroundColor))
  expect(await head.evaluate((element) => getComputedStyle(element).borderRadius)).toBe('50%')
  await mkdir(resolve(web, 'artifacts/vox'), { recursive: true })
  await page.screenshot({ path: resolve(web, 'artifacts/vox/call-desktop.png') })
  await page.setViewportSize({ width: 390, height: 844 })
  await expectAt(318, 772)
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: resolve(web, 'artifacts/vox/call-mobile.png') })
  await page.getByRole('button', { name: 'Switch to dark mode', exact: true }).click()
  await page.evaluate(async () => {
    await Promise.all(document.getAnimations().filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
      .map((animation) => animation.finished.catch(() => {})))
  })
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await page.screenshot({ path: resolve(web, 'artifacts/vox/call-mobile-dark.png') })
  const touch = await context.newCDPSession(page)
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 346, y: 800 }] })
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: 65, y: 360 }] })
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await touch.detach()
  await expectAt(16, 332)
  await expect(panel).toHaveCount(0)
  await expect(head).toHaveAttribute('data-listening', 'true')
  expect((await updates.boundingBox()).x).toBe(16)
  await page.screenshot({ path: resolve(web, 'artifacts/vox/call-dragged-left.png') })
  await updates.getByRole('button', { name: 'Dismiss your message' }).click()
  await expect(userNotice).toHaveCount(0)
  await expect(replyNotice).toBeVisible()
  await expect(replyNotice).toHaveCount(0, { timeout: 15000 })
  await head.click()
  const openedBox = await panel.boundingBox()
  expect(openedBox.x).toBe(16)
  expect(openedBox.y).toBeGreaterThanOrEqual(16)
  expect(openedBox.y + openedBox.height).toBeLessThanOrEqual(828)
  await expect(head).toBeVisible()
  await head.focus()
  await page.keyboard.press('Home')
  await expectAt(318, 772)
  await expect(panel.getByRole('log')).toContainText('List my projects.')
  await expect(panel.getByRole('log').getByText('Reply: Projects: Studio website · done', { exact: true })).toHaveCount(1)
  await expect(panel).toContainText('work · personal')
  await expect(panel.locator('.vox-message--user')).toHaveCount(1)
  await expect(panel.locator('.vox-message--assistant')).toHaveCount(1)
  await expect(panel.getByRole('log')).not.toContainText("Hi, I'm Vox")
  const endBox = await panel.getByRole('button', { name: 'End call', exact: true }).boundingBox()
  const callBox = await panel.boundingBox()
  expect(Math.abs(endBox.x + endBox.width / 2 - callBox.x - callBox.width / 2)).toBeLessThan(1)
  await panel.getByRole('button', { name: 'Mute speaker', exact: true }).click()
  expect(await page.evaluate(() => window.__voxTestAudio.every((audio) => audio.muted))).toBe(true)
  await panel.getByRole('button', { name: 'Unmute speaker', exact: true }).click()
  expect(await page.evaluate(() => window.__voxTestAudio.every((audio) => !audio.muted))).toBe(true)
  await panel.getByRole('button', { name: 'Mute', exact: true }).click()
  await expect(panel.getByText('Microphone muted', { exact: true })).toBeVisible()
  await panel.getByRole('button', { name: 'Unmute', exact: true }).click()
  // The fake capture file loops. Keep later speech from interrupting typed
  // tool requests after the spoken exchange and mute/unmute controls pass.
  await panel.getByRole('button', { name: 'Mute', exact: true }).click()
  async function say(text) {
    await panel.getByRole('textbox', { name: 'Message Vox' }).fill(text)
    await panel.getByRole('button', { name: 'Send to Vox', exact: true }).click()
  }
  await say('Inspect profiles and allowance')
  await expect(panel.getByRole('log')).toContainText('Selected profile work', { timeout: 15000 })
  await panel.getByRole('button', { name: 'Hide Vox', exact: true }).click()
  await expect(userNotice).toHaveCount(1)
  await expect(userNotice).toContainText('Inspect profiles and allowance')
  await expect(updates).not.toContainText('List my projects.')
  await expect(replyNotice).toHaveCount(1)
  await expect(replyNotice).toContainText('Selected profile work')
  await expect(updates).not.toContainText('Projects: Studio website')
  await head.click()
  await say('Investigate this project')
  await expect(panel.getByRole('log')).toContainText('Investigation started', { timeout: 15000 })
  await panel.locator('.vox-investigations > summary').click()
  await expect(panel.getByRole('region', { name: 'Vox investigations' })).toContainText('Vox project audit')
  await say('What is the task status?')
  await expect(panel.getByRole('log')).toContainText('Task running', { timeout: 15000 })
  await expect(panel.getByRole('region', { name: 'Vox investigations' })).toContainText('completed', { timeout: 15000 })
  await say('Investigate this project again')
  await expect(panel.getByRole('log')).toContainText('Investigation started', { timeout: 15000 })
  await expect(panel.getByRole('region', { name: 'Vox investigations' }).getByRole('link')).toHaveCount(2)
  await say('Stop this task')
  await expect(panel.getByRole('region', { name: 'Vox investigations' })).toContainText('interrupted', { timeout: 15000 })
  await expect(panel.getByRole('log')).toContainText('interrupted', { timeout: 15000 })
  await panel.getByRole('button', { name: 'Hide Vox', exact: true }).click()
  await expect(userNotice).toHaveCount(1)
  await expect(replyNotice).toHaveCount(1)
  await expect(userNotice).toContainText('Stop this task')
  await page.getByRole('navigation', { name: 'Workspace navigation' }).getByRole('link', { name: 'Home', exact: true }).click()
  await head.click()
  await expect(panel.getByRole('log')).toContainText('Stop this task')
  await expect(panel.locator('.vox-message--user')).toHaveCount(1)
  await expect(panel.locator('.vox-message--assistant')).toHaveCount(1)
  await page.screenshot({ path: resolve(web, 'artifacts/vox/call-panel-mobile-dark.png') })
  await say('Investigate this project once more')
  await expect(panel.getByRole('log')).toContainText('Investigation started', { timeout: 15000 })
  await panel.getByRole('button', { name: 'Disconnect microphone', exact: true }).click()
  await expect(panel.getByRole('button', { name: 'Connect microphone', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze()).violations).toEqual([])
  await mkdir(resolve(web, 'artifacts/vox'), { recursive: true })
  await page.screenshot({ path: resolve(web, 'artifacts/vox/mobile.png'), fullPage: true })
  await panel.getByRole('button', { name: 'End call', exact: true }).click()
  await expect(panel).toHaveCount(0)
  await head.click()
  await expect(panel.getByRole('button', { name: 'Start call', exact: true })).toBeVisible()
  // Exercise fresh calls in the same browser and Python worker, after cleanup.
  for (let cycle = 1; cycle <= 2; cycle++) {
    const started = performance.now()
    await panel.getByRole('button', { name: 'Start call', exact: true }).click()
    await expect(head).toHaveAttribute('data-listening', 'true', { timeout: 15000 })
    console.log(`Vox repeated call ${cycle} connected in ${Math.round(performance.now() - started)} ms`)
    await head.click()
    await panel.getByRole('button', { name: 'End call', exact: true }).click()
    await expect(panel).toHaveCount(0)
    await head.click()
    await expect(panel.getByRole('button', { name: 'Start call', exact: true })).toBeVisible()
  }
  expect(await page.evaluate(() => window.__voxTestPeers.every((peer) => peer.connectionState === 'closed'))).toBe(true)
  expect(await page.evaluate(() => window.__voxTestStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended')))).toBe(true)
  await expect.poll(async () => {
    const threads = JSON.parse(await readFile(resolve(work, 'manager/codex/agents/work/fixture-threads.json'), 'utf8'))
    return Object.values(threads).filter((thread) => !thread.dynamicTools?.length && thread.turns.length)
      .map((thread) => thread.turns.at(-1).status).sort()
  }, { timeout: 15000 }).toEqual(['completed', 'completed', 'interrupted'])
  const threads = JSON.parse(await readFile(resolve(work, 'manager/codex/agents/work/fixture-threads.json'), 'utf8'))
  for (const thread of Object.values(threads).filter((thread) => !thread.dynamicTools?.length && thread.turns.length))
    expect(thread.sandbox).toBe('read-only')
  expect(errors).toEqual([])
  console.log('PASS: Vox spoken greeting, one bubble per speaker, call panel, mute/speaker/end controls, drag/snapping, mobile accessibility, real speech/WebRTC, and durable investigations.')
  }
} catch (error) {
  failed = true
  console.error(error)
  for (const readLog of logs) console.error(readLog())
  process.exitCode = 1
} finally {
  await browser?.close()
  spawnSync(resolve(binaries, 'uc'), ['stop', '--all', '--force'], { env, timeout: 10000, stdio: 'ignore' })
  spawnSync(resolve(binaries, 'uc'), ['daemon', 'stop'], { env, timeout: 10000, stdio: 'ignore' })
  for (const child of children.reverse()) {
    try { process.kill(-child.pid, 'SIGTERM') } catch {}
    try { process.kill(-child.pid, 'SIGKILL') } catch {}
  }
  if (!failed) await rm(work, { recursive: true, force: true })
  else console.error('Retained isolated test data:', work)
}
