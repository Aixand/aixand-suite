import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../desktop/src-tauri/launcher')
const files = {
  '/': ['index.html', 'text/html'],
  '/launcher.js': ['launcher.js', 'text/javascript'],
  '/launcher.css': ['launcher.css', 'text/css'],
}
createServer(async (request, response) => {
  const asset = files[new URL(request.url, 'http://localhost').pathname]
  if (!asset) { response.writeHead(404).end(); return }
  try {
    const data = await readFile(resolve(root, asset[0]))
    response.writeHead(200, { 'Content-Type': asset[1], 'Cache-Control': 'no-store' }).end(data)
  } catch { response.writeHead(500).end() }
}).listen(Number(process.env.AIXAND_DESKTOP_TEST_PORT || 18753), '127.0.0.1')
