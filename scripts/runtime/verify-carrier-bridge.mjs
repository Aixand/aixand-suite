// Native bridge qualification against disposable Carrier and authentication data.
// Usage: node verify-carrier-bridge.mjs SERVER PYTHON [BRIDGE] [CARRIER_SERVICE_PYTHON]
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { verifyCarrier } from './verify-carrier.mjs'

const [server, python, bridge, servicePython] = process.argv.slice(2)
if (!server || !python) throw new Error('Provide the server directory and Suite Python interpreter.')
const root = await mkdtemp(join(tmpdir(), 'aixand-carrier-native-'))
const require = createRequire(join(resolve(server), 'package.json'))
const { WebSocket, WebSocketServer } = require('ws')
async function freePort() {
  const socket = createServer()
  await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve))
  const port = socket.address().port
  await new Promise(resolve => socket.close(resolve))
  return port
}
const carrierPort = await freePort()
Object.assign(process.env, {
  AGENTS_PYTHON: resolve(python), CARRIER_PYTHON: resolve(python),
  CARRIER_BRIDGE_PATH: resolve(bridge || join(server, 'carrier-bridge/main.py')),
  CARRIER_STATE_DIR: join(root, 'state'), CARRIER_STATE_DATABASE: join(root, 'state/suite.db'),
  CARRIER_DATABASE: join(root, 'carrier.db'), CARRIER_URL: `http://127.0.0.1:${carrierPort}`,
  CARRIER_USER_CREDENTIALS: join(root, 'state/user.json'), CARRIER_USER_ADDRESS: 'suite/local/user',
  CARRIER_AUTO_PROVISION: '1', CARRIER_POLL_INTERVAL: '0.1', CARRIER_AGENT_CONFIG: '', CARRIER_MAILBOXES_FILE: '',
  AIXAND_AUTH_DATABASE: join(root, 'auth/auth.db'), AIXAND_AUTH_DEV_HTTP: '1', AIXAND_AUTH_LOOPBACK_HTTP: '1',
  AIXAND_TRUST_PROXY: '', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', PYTHONDONTWRITEBYTECODE: '1',
})
delete process.env.CARRIER_INSTANCE_ID
const service = spawn(resolve(servicePython || python), ['-B', '-m', 'carrier.cli', 'serve', '--db', process.env.CARRIER_DATABASE,
  '--host', '127.0.0.1', '--port', String(carrierPort)], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true })
let diagnostics = '', launchError
service.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8192) })
service.on('error', error => { launchError = error })
let auth, adapter, gateway, socket
const fromServer = name => import(pathToFileURL(join(resolve(server), 'dist', name)))
try {
  const deadline = Date.now() + 15_000
  while (true) {
    if (launchError) throw launchError
    if (service.exitCode !== null) throw new Error(`Carrier exited: ${diagnostics}`)
    try { if ((await fetch(process.env.CARRIER_URL + '/health')).ok) break } catch {}
    if (Date.now() > deadline) throw new Error('Isolated Carrier did not start')
    await delay(100)
  }
  const { AuthService } = await fromServer('auth/auth.service.js')
  const { hashPassword } = await fromServer('auth/password.js')
  const { tokenHash } = await fromServer('auth/store.js')
  const { CarrierService } = await fromServer('carrier/carrier.service.js')
  const { CarrierGateway } = await fromServer('carrier/carrier.gateway.js')
  auth = new AuthService()
  auth.store.db.prepare("UPDATE workspace_auth SET state='configured', password_hash=?, credential_version=1 WHERE id=1")
    .run(await hashPassword('Isolated Carrier verification 9274!'))
  const token = randomBytes(32).toString('base64url'), now = Date.now()
  auth.store.db.prepare('INSERT INTO auth_sessions VALUES (?, ?, ?, ?, ?, ?)')
    .run(tokenHash(token), 1, randomBytes(32).toString('base64url'), now, now, now + 3600_000)
  adapter = new CarrierService()
  gateway = new CarrierGateway(adapter, auth, { setCommandSource() {} })
  socket = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/api/carrier/ws' })
  socket.on('connection', (client, request) => gateway.handleConnection(client, request))
  await new Promise(resolve => socket.once('listening', resolve))
  const address = `http://127.0.0.1:${socket.address().port}`
  process.env.CORS_ORIGINS = address
  const first = await verifyCarrier(WebSocket, address, `aixand-dev-session=${token}`)
  const second = await verifyCarrier(WebSocket, address, `aixand-dev-session=${token}`)
  assert.equal(second.instance, first.instance, 'Reconnect must retain the same dataset')
  console.log(JSON.stringify({ passed: true, platform: process.platform,
    checks: ['authenticated Carrier WebSocket', 'Node-to-Python pipes', 'mailbox provisioning',
      'synchronized snapshot', 'Unicode request', 'Suite SDK availability', 'reconnect retains dataset'] }))
} finally {
  gateway?.onApplicationShutdown()
  if (socket) {
    for (const client of socket.clients) client.terminate()
    await new Promise(resolve => socket.close(resolve))
  }
  await adapter?.onApplicationShutdown()
  auth?.onApplicationShutdown()
  if (service.exitCode === null && service.signalCode === null && !launchError) {
    const closed = new Promise(resolve => service.once('close', resolve))
    service.kill()
    await closed
  }
  await rm(root, { recursive: true, force: true })
}
