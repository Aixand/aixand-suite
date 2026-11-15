// Real Server authentication with a disposable database; no agent runtimes.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const server = resolve(import.meta.dirname, '../../server')
const require = createRequire(resolve(server, 'package.json'))
const { Module } = require('@nestjs/common')
const { NestFactory } = require('@nestjs/core')
const { WebSocketServer } = require('ws')
const load = path => import(pathToFileURL(resolve(server, 'dist', path)).href)
const { initializeAuthDatabase, AuthStore } = await load('auth/store.js')
const { hashPassword } = await load('auth/password.js')
initializeAuthDatabase(process.env.AIXAND_AUTH_DATABASE)
const store = new AuthStore(process.env.AIXAND_AUTH_DATABASE)
store.db.prepare("UPDATE workspace_auth SET state='configured', password_hash=?, credential_version=1 WHERE id=1").run(await hashPassword('isolated Suite password 9274!'))
store.close()
const { AuthModule } = await load('auth/auth.module.js')
const { AuthService } = await load('auth/auth.service.js')
const { configureApp } = await load('configure-app.js')
class ClientAuthFixture {}
Module({ imports: [AuthModule] })(ClientAuthFixture)
const app = await NestFactory.create(ClientAuthFixture, { logger: false })
configureApp(app)
const express = app.getHttpAdapter().getInstance()
express.get('/api/health', (_request, response) => response.set('x-aixand-protocol', '1').json({ status: 'ok', service: 'aixand-server' }))
express.get('/api/client-probe', (_request, response) => response.json({ authenticated: true }))
const socketServer = new WebSocketServer({ noServer: true })
app.getHttpServer().on('upgrade', (request, socket, head) => {
  if (request.url !== '/api/terminals/ws') return socket.destroy()
  socketServer.handleUpgrade(request, socket, head, client => {
    if (app.get(AuthService).authorizeSocket(client, request)) client.on('message', data => client.send(data.toString()))
  })
})
await app.listen(Number(process.env.PORT), '127.0.0.1')
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { socketServer.close(); await app.close(); process.exit() })
console.log('Client authentication fixture ready')
