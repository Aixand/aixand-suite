import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile, rm, symlink, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startClient, backendUrl } from './desktop-client.mjs'

const { WebSocket, WebSocketServer } = createRequire(new URL('../../apps/server/package.json', import.meta.url))('ws')
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-desktop-client-'))
  const web = join(directory, 'web'); await mkdir(web)
  await writeFile(join(web, 'index.html'), '<title>Bundled Desktop</title>')
  await writeFile(join(web, 'recovery.html'), '<title>Recovery</title>')
  await writeFile(join(directory, 'private'), 'must not be served')
  const received = []
  const backend = createServer((request, response) => {
    received.push({ path: request.url, headers: request.headers })
    if (request.url === '/api/login') {
      response.setHeader('Set-Cookie', ['__Host-aixand-session-prod-fixture=fixture-token; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=120', 'unrelated=must-not-cross; Path=/'])
      response.end('{}')
    } else if (request.url === '/api/logout') {
      response.setHeader('Set-Cookie', '__Host-aixand-session-prod-fixture=; Path=/; Secure; Max-Age=0')
      response.end('{}')
    } else { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ api: true })) }
  })
  await new Promise(ready => backend.listen(0, '127.0.0.1', ready))
  const origin = 'http://127.0.0.1:' + backend.address().port
  const ws = new WebSocketServer({ server: backend, path: '/api/test/ws' })
  ws.on('connection', (socket, request) => { received.push({ path: request.url, headers: request.headers }); socket.send('fixture-connected') })
  const client = await startClient({ backend: origin, web, profile: 'fixture', stateFile: join(directory, 'client.json') })
  return { directory, web, received, origin, client, close: async () => {
    await client.close(); for (const socket of ws.clients) socket.terminate()
    await new Promise(ready => ws.close(ready)); await new Promise(ready => backend.close(ready))
    await rm(directory, { recursive: true, force: true })
  } }
}
async function open(client) {
  const response = await fetch(client.address, { redirect: 'manual' })
  assert.equal(response.status, 303)
  return response.headers.get('set-cookie').split(';')[0]
}

test('bundled UI works against an API-only server and bootstrap is private and one-use', async () => {
  const f = await fixture()
  try {
    assert.equal((await fetch(f.client.origin)).status, 403)
    const cookie = await open(f.client)
    assert.equal((await fetch(f.client.address, { redirect: 'manual' })).status, 403)
    const page = await fetch(f.client.origin, { headers: { Cookie: cookie } })
    assert.match(await page.text(), /Bundled Desktop/)
    const api = await fetch(f.client.origin + '/api/health', { headers: { Cookie: cookie, Origin: f.client.origin } })
    assert.deepEqual(await api.json(), { api: true })
    assert.equal(f.received.at(-1).headers.origin, f.origin)
    assert.equal(f.received.at(-1).headers.cookie, undefined, 'The local access cookie is never sent to the server')
    assert.equal((await fetch(f.client.origin + '/api/health', { headers: { Cookie: cookie, Origin: 'https://attacker.example' } })).status, 403)
    const forgedHost = await new Promise((ready, fail) => {
      const request = httpRequest(f.client.origin, { headers: { Cookie: cookie, Host: 'attacker.example' } }, response => { response.resume(); ready(response.statusCode) })
      request.once('error', fail); request.end()
    })
    assert.equal(forgedHost, 403)
  } finally { await f.close() }
})

test('maps only official session cookies and preserves CSRF and upstream origin on API and WebSocket requests', async () => {
  const f = await fixture()
  try {
    const access = await open(f.client)
    const login = await fetch(f.client.origin + '/api/login', { method: 'POST', headers: { Cookie: access, Origin: f.client.origin } })
    const cookies = login.headers.getSetCookie()
    assert.equal(cookies.length, 1)
    assert.match(cookies[0], /HttpOnly; SameSite=Strict/)
    assert.doesNotMatch(cookies[0], /; Secure/)
    const session = cookies[0].split(';')[0], cookie = access + '; ' + session
    await fetch(f.client.origin + '/api/check', { headers: { Cookie: cookie, Origin: f.client.origin,
      'X-CSRF-Token': 'fixture-csrf', 'X-Forwarded-For': 'forged' } })
    assert.equal(f.received.at(-1).headers.cookie, '__Host-aixand-session-prod-fixture=fixture-token')
    assert.equal(f.received.at(-1).headers['x-csrf-token'], 'fixture-csrf')
    assert.equal(f.received.at(-1).headers['x-forwarded-for'], undefined)
    const socket = new WebSocket(f.client.origin.replace('http:', 'ws:') + '/api/test/ws', { origin: f.client.origin, headers: { Cookie: cookie } })
    try {
      await new Promise((ready, fail) => { socket.once('error', fail); socket.once('message', message => { assert.equal(String(message), 'fixture-connected'); ready() }) })
      assert.equal(f.received.at(-1).headers.origin, f.origin)
      assert.equal(f.received.at(-1).headers.cookie, '__Host-aixand-session-prod-fixture=fixture-token')
    } finally { socket.terminate() }
    const logout = await fetch(f.client.origin + '/api/logout', { method: 'POST', headers: { Cookie: cookie, Origin: f.client.origin } })
    assert.match(logout.headers.get('set-cookie'), /Max-Age=0/)
    const other = await startClient({ backend: f.origin, web: f.web, profile: 'another-profile' })
    try { assert.equal((await fetch(other.origin + '/api/health', { headers: { Cookie: cookie } })).status, 403) }
    finally { await other.close() }
  } finally { await f.close() }
})

test('asset traversal and links cannot expose files outside the Desktop UI', async () => {
  const f = await fixture()
  try {
    if (process.platform !== 'win32') await symlink(join(f.directory, 'private'), join(f.web, 'linked'))
    const cookie = await open(f.client)
    for (const path of ['/..%2fprivate', '/%2e%2e%5cprivate', '/.env', '/missing', ...(process.platform === 'win32' ? [] : ['/linked'])])
      assert.equal((await fetch(f.client.origin + path, { headers: { Cookie: cookie } })).status, 404, path)
  } finally { await f.close() }
})

test('rejects credentials, paths and non-loopback HTTP backend addresses', () => {
  for (const address of ['http://example.com/', 'https://user:pass@example.com/', 'https://example.com/path', 'file:///tmp/file'])
    assert.throws(() => backendUrl(address))
  assert.equal(backendUrl('https://example.com/').origin, 'https://example.com')
})

test('restarting a client preserves its browser origin while replacing private gateway access', async () => {
  const f = await fixture()
  try {
    const old = await open(f.client), origin = f.client.origin
    await f.client.close()
    const current = await startClient({ backend: f.origin, web: f.web, profile: 'fixture', stateFile: join(f.directory, 'client.json') })
    try {
      assert.equal(current.origin, origin)
      assert.equal((await fetch(origin, { headers: { Cookie: old } })).status, 403)
      const next = await open(current)
      assert.equal((await fetch(origin, { headers: { Cookie: next } })).status, 200)
    } finally { await current.close() }
  } finally { await f.close() }
})

test('a redirected settings file cannot overwrite an unrelated file', { skip: process.platform === 'win32' }, async () => {
  const f = await fixture()
  try {
    const link = join(f.directory, 'redirected.json'), target = join(f.directory, 'private')
    await symlink(target, link)
    await assert.rejects(startClient({ backend: f.origin, web: f.web, profile: 'fixture', stateFile: link }), /link or junction/)
    assert.equal(await readFile(target, 'utf8'), 'must not be served')
  } finally { await f.close() }
})

test('replaces an occupied saved port and preserves the replacement on the next start', async () => {
  const f = await fixture()
  const occupied = createServer()
  let current
  try {
    const oldCookie = await open(f.client), oldOrigin = f.client.origin
    await f.client.close()
    await new Promise((ready, fail) => {
      occupied.once('error', fail)
      occupied.listen(Number(new URL(oldOrigin).port), '127.0.0.1', ready)
    })
    const options = { backend: f.origin, web: f.web, profile: 'fixture', stateFile: join(f.directory, 'client.json') }
    current = await startClient(options)
    assert.notEqual(current.origin, oldOrigin)
    assert.equal((await fetch(current.origin, { headers: { Cookie: oldCookie } })).status, 403)
    const cookie = await open(current)
    assert.deepEqual(await (await fetch(current.origin + '/api/health', { headers: { Cookie: cookie } })).json(), { api: true })
    assert.equal(JSON.parse(await readFile(options.stateFile, 'utf8')).port, Number(new URL(current.origin).port))
    const replacement = current.origin
    await current.close()
    current = await startClient(options)
    assert.equal(current.origin, replacement)
    // An explicitly requested port is not a saved preference and still fails.
    await assert.rejects(startClient({ backend: f.origin, web: f.web, profile: 'explicit', port: Number(new URL(oldOrigin).port) }),
      { code: 'EADDRINUSE' })
  } finally {
    if (current) await current.close()
    await new Promise(ready => occupied.close(ready))
    await f.close()
  }
})
