// Desktop owns its UI. This loopback gateway keeps HTTP and WebSockets on one
// browser origin while forwarding only API traffic to the selected Suite host.
import { createServer, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, mkdir, realpath, stat, lstat, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve, extname, relative, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

const hop = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])
const sessionName = name => /^(?:__Host-)?aixand-session(?:-[A-Za-z0-9_-]+)?$/.test(name) || name === 'aixand-dev-session'
const cookiePairs = value => String(value || '').split(';').map(part => part.trim().split(/=(.*)/s).slice(0, 2))
const constant = (left, right) => typeof left === 'string' && Buffer.byteLength(left) === Buffer.byteLength(right) && timingSafeEqual(Buffer.from(left), Buffer.from(right))
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
  '.woff': 'font/woff', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.wasm': 'application/wasm' }

export function backendUrl(value) {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash ||
      url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    throw new Error('Use the root HTTPS server address or an HTTP loopback address.')
  return url
}

export async function startClient({ backend, web, profile, stateFile, port = 0 }) {
  const target = backendUrl(backend), directory = await realpath(web)
  for (const name of ['index.html', 'recovery.html'])
    if (!(await stat(join(directory, name))).isFile()) throw new Error('The Desktop interface is incomplete. Repair Desktop.')
  const id = createHash('sha256').update(profile + '\0' + target.origin).digest('hex').slice(0, 20)
  const prefix = 'aixand-desktop-' + id + '-', accessName = prefix + 'access'
  const token = randomBytes(32).toString('hex'), access = randomBytes(32).toString('hex')
  let entryAvailable = true
  const sockets = new Set()
  let origin

  function allowed(incoming) {
    return incoming.headers.host === new URL(origin).host &&
      (!incoming.headers.origin || incoming.headers.origin === origin) &&
      !['cross-site'].includes(incoming.headers['sec-fetch-site']) &&
      cookiePairs(incoming.headers.cookie).some(([name, value]) => name === accessName && constant(value, access))
  }
  function headers(incoming, upgrade) {
    const excluded = new Set([...hop, ...String(incoming.headers.connection || '').toLowerCase().split(',').map(value => value.trim()),
      'host', 'cookie', 'origin', 'referer', 'forwarded', 'accept-encoding'])
    const result = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) => !excluded.has(name) && !name.startsWith('x-forwarded-')))
    result.host = target.host
    result.origin = target.origin
    const cookies = cookiePairs(incoming.headers.cookie).flatMap(([name, value]) => {
      if (!name.startsWith(prefix + 'session-') || !value) return []
      const remote = Buffer.from(name.slice((prefix + 'session-').length), 'base64url').toString()
      return sessionName(remote) && !/[\r\n;]/.test(value) ? [remote + '=' + value] : []
    })
    if (cookies.length) result.cookie = cookies.join('; ')
    if (upgrade) { result.connection = 'Upgrade'; result.upgrade = 'websocket' }
    return result
  }
  function responseHeaders(incoming) {
    const result = Object.fromEntries(Object.entries(incoming.headers).filter(([name]) =>
      !hop.has(name) && !name.startsWith('access-control-') && !['set-cookie', 'content-security-policy', 'clear-site-data'].includes(name)))
    const cookies = (incoming.headers['set-cookie'] || []).flatMap(cookie => {
      const [pair, ...attributes] = cookie.split(';'), split = pair.indexOf('=')
      const name = pair.slice(0, split), value = pair.slice(split + 1)
      if (!sessionName(name) || /[\r\n]/.test(value)) return []
      const lifetime = attributes.filter(value => /^\s*(?:max-age|expires)=/i.test(value))
      return [prefix + 'session-' + Buffer.from(name).toString('base64url') + '=' + value + '; Path=/; HttpOnly; SameSite=Strict' +
        (lifetime.length ? '; ' + lifetime.join('; ') : '')]
    })
    if (cookies.length) result['set-cookie'] = cookies
    if (result.location) {
      try {
        const location = new URL(result.location, target)
        if (location.origin === target.origin) result.location = origin + location.pathname + location.search + location.hash
      } catch { delete result.location }
    }
    return result
  }
  function forward(incoming, outgoing, head) {
    const upgrade = head !== undefined
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(new URL(incoming.url, target),
      { method: incoming.method, headers: headers(incoming, upgrade), timeout: 300_000 }, response => {
        if (upgrade) {
          response.resume(); outgoing.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); return
        }
        outgoing.writeHead(response.statusCode, responseHeaders(response))
        response.pipe(outgoing)
      })
    request.once('timeout', () => request.destroy(new Error('Backend request timed out')))
    request.once('error', () => {
      if (upgrade) outgoing.destroy()
      else if (!outgoing.headersSent) { outgoing.writeHead(502, { 'Content-Type': 'application/json' }); outgoing.end(JSON.stringify({ message: 'The selected Aixand server is unavailable.' })) }
      else outgoing.destroy()
    })
    incoming.once('aborted', () => request.destroy())
    outgoing.once('close', () => request.destroy())
    if (upgrade) {
      request.once('upgrade', (response, remote, remoteHead) => {
        outgoing.write('HTTP/1.1 101 Switching Protocols\r\n' + Object.entries(response.headers)
          .filter(([name]) => ['upgrade', 'connection', 'sec-websocket-accept', 'sec-websocket-protocol', 'sec-websocket-extensions'].includes(name))
          .map(([name, value]) => `${name}: ${value}\r\n`).join('') + '\r\n')
        if (remoteHead.length) outgoing.write(remoteHead)
        if (head.length) remote.write(head)
        remote.on('error', () => outgoing.destroy()); outgoing.on('error', () => remote.destroy())
        outgoing.once('close', () => remote.destroy()); remote.once('close', () => outgoing.destroy())
        outgoing.pipe(remote).pipe(outgoing)
      })
      request.end()
    } else incoming.pipe(request)
  }

  const server = createServer(async (incoming, outgoing) => {
    outgoing.setHeader('Referrer-Policy', 'no-referrer')
    outgoing.setHeader('X-Content-Type-Options', 'nosniff')
    outgoing.setHeader('X-Frame-Options', 'DENY')
    outgoing.setHeader('Content-Security-Policy', "frame-ancestors 'none'")
    outgoing.setHeader('Cache-Control', 'no-store')
    if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//')) { outgoing.writeHead(400); outgoing.end(); return }
    const url = new URL(incoming.url, origin)
    if (incoming.headers.host === new URL(origin).host && entryAvailable && incoming.method === 'GET' && url.pathname === '/' &&
      (!incoming.headers.origin || incoming.headers.origin === origin) && constant(url.searchParams.get('connect'), token)) {
      entryAvailable = false
      outgoing.writeHead(303, { Location: '/', 'Set-Cookie': `${accessName}=${access}; Path=/; HttpOnly; SameSite=Strict` })
      outgoing.end(); return
    }
    if (!allowed(incoming)) { outgoing.writeHead(403); outgoing.end('Open this workspace through the Aixand connection window.'); return }
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) { forward(incoming, outgoing); return }
    if (!['GET', 'HEAD'].includes(incoming.method)) { outgoing.writeHead(405); outgoing.end(); return }
    try {
      const path = decodeURIComponent(url.pathname)
      if (path.split(/[\\/]/).some(value => value === '..' || value.startsWith('.')) || path.includes('\0')) throw new Error('Invalid asset path')
      const file = await realpath(join(directory, path === '/' ? 'index.html' : path.slice(1)))
      const within = relative(directory, file)
      if (within.startsWith('..') || isAbsolute(within)) throw new Error('Asset outside interface')
      const info = await stat(file)
      if (!info.isFile()) throw new Error('Not an asset')
      outgoing.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream', 'Content-Length': info.size })
      if (incoming.method === 'HEAD') outgoing.end()
      else createReadStream(file).on('error', () => outgoing.destroy()).pipe(outgoing)
    } catch { outgoing.writeHead(404); outgoing.end() }
  })
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  server.on('upgrade', (incoming, socket, head) => {
    if (!allowed(incoming) || !incoming.url?.startsWith('/api/') || incoming.headers.upgrade?.toLowerCase() !== 'websocket') {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return
    }
    forward(incoming, socket, head)
  })
  if (stateFile) {
    for (let path = resolve(stateFile); ; path = dirname(path)) {
      const info = await lstat(path).catch(error => { if (error.code !== 'ENOENT') throw error })
      if (info?.isSymbolicLink()) throw new Error('Desktop connection settings cannot traverse a link or junction.')
      if (dirname(path) === path) break
    }
    try {
      const saved = JSON.parse(await readFile(stateFile, 'utf8'))
      if (saved.id === id && Number.isInteger(saved.port) && saved.port >= 1024 && saved.port <= 65535) port = saved.port
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  await new Promise((ready, fail) => { server.once('error', fail); server.listen(port, '127.0.0.1', () => {
    origin = 'http://127.0.0.1:' + server.address().port; ready()
  }) })
  if (stateFile) {
    try {
      await mkdir(dirname(stateFile), { recursive: true, mode: 0o700 })
      const temporary = stateFile + '.' + randomBytes(12).toString('hex') + '.new'
      try {
        await writeFile(temporary, JSON.stringify({ id, port: server.address().port }) + '\n', { mode: 0o600, flag: 'wx' })
        await rename(temporary, stateFile)
      } finally { await rm(temporary, { force: true }) }
    } catch (error) { server.close(); throw error }
  }
  return { address: origin + '/?connect=' + token, origin,
    close: () => new Promise(resolveClose => { for (const socket of sockets) socket.destroy(); server.close(resolveClose) }) }
}

if (import.meta.main) {
  try {
    const options = JSON.parse(process.argv[2] || '{}')
    const root = dirname(fileURLToPath(import.meta.url))
    const client = await startClient({ ...options, web: join(root, 'web') })
    console.log(JSON.stringify({ address: client.address }))
    // The native parent owns this UI gateway, never the remote runtime. Its
    // stdin pipe closes on normal exit, crash or connection replacement.
    process.stdin.resume()
    process.stdin.once('end', async () => { await client.close() })
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
