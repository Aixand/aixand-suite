// Browser harness server with disposable caches, including read-only node_modules.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { createServer } from 'vite'
import webConfig from '../vite.config.ts'

const { values } = parseArgs({ options: {
  host: { type: 'string', default: '127.0.0.1' },
  port: { type: 'string' }, strictPort: { type: 'boolean', default: true },
} })
const cacheDir = await mkdtemp(resolve(tmpdir(), 'suite-vite-cache-'))
const config = webConfig({ command: 'serve', mode: 'development' })
const server = await createServer({
  ...config, configFile: false, cacheDir,
  // Acceptance runs use a fixed source snapshot; avoid host inotify limits.
  server: { ...config.server, host: values.host, port: Number(values.port), strictPort: values.strictPort, watch: null },
})
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
  await server.close()
  await rm(cacheDir, { recursive: true, force: true })
  process.exit(0)
})
await server.listen()
server.printUrls()
