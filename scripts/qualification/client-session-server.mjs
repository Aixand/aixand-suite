// Production Server auth + configureApp; fixture-only authenticated echo socket.
// No provider runtimes or browser/native IPC emulation.
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const [server, output, port] = process.argv.slice(2)
const require = createRequire(resolve(server, 'package.json'))
const { Module } = require('@nestjs/common')
const { NestFactory } = require('@nestjs/core')
const { WebSocketServer } = require('ws')
const load = name => import(pathToFileURL(resolve(output, name)).href)
const { AuthModule } = await load('auth/auth.module.js')
const { AuthService } = await load('auth/auth.service.js')
const { configureApp } = await load('configure-app.js')
class SessionFixture {}
Module({ imports: [AuthModule] })(SessionFixture)
const app = await NestFactory.create(SessionFixture, { logger: false })
configureApp(app)
const sockets = new WebSocketServer({ noServer: true })
app.getHttpServer().on('upgrade', (request, socket, head) => {
  if (request.url !== '/api/terminals/ws') return socket.destroy()
  sockets.handleUpgrade(request, socket, head, client => {
    if (app.get(AuthService).authorizeSocket(client, request)) client.on('message', data => client.send(data.toString()))
  })
})
await app.listen(Number(port), '127.0.0.1')
console.log('READY')
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  for (const socket of sockets.clients) socket.terminate()
  sockets.close(); await app.close(); process.exit()
})
