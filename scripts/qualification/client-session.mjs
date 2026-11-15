import { mkdtemp, mkdir, readFile, writeFile, copyFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createServer } from 'node:net'
import { buildTestServer } from '../../apps/web/scripts/isolated-test-server.mjs'

if (process.env.AIXAND_SESSION_CONTAINED !== '1' || !process.env.HOME?.startsWith('/tmp/')) throw Error('Run in the documented bwrap private HOME/network/PID containment')
const here = dirname(fileURLToPath(import.meta.url)), root = resolve(here, '../..')
const work = await mkdtemp('/tmp/client-session-')
const server = resolve(root, 'apps/server')
const evidence = process.env.AIXAND_SESSION_EVIDENCE
if (!evidence?.startsWith(`${root}/`)) throw Error('Explicit evidence directory under isolated source required')
await mkdir(evidence, { recursive: true })
let log = '', backend
const children = new Set()
async function run(command, args, options = {}) {
  return await new Promise((done, fail) => {
    const child = spawn(command, args, { cwd: work, env: process.env, ...options }); children.add(child)
    let output = ''
    child.stdout.on('data', chunk => { output += chunk; log += chunk })
    child.stderr.on('data', chunk => { log += chunk })
    child.once('error', fail)
    child.once('exit', code => { children.delete(child); code === 0 ? done(output) : fail(Error(`${command} exited ${code}; ${log.slice(-4000)}`)) })
  })
}
async function stop(child) {
  if (!child || child.exitCode !== null) return
  await new Promise(done => { child.once('exit', done); child.kill('SIGTERM') })
}
try {
  const main = buildTestServer(server,work), output = dirname(main)
  const cargo = resolve(work,'probe'); await mkdir(resolve(cargo,'src'),{recursive:true})
  const transport = resolve(root,'apps/desktop/src-tauri/transport')
  await writeFile(resolve(cargo,'Cargo.toml'), `[package]\nname="suite-client-session-probe"\nversion="0.0.0"\nedition="2024"\n[dependencies]\naixand-client-transport={path=${JSON.stringify(transport)}}\nserde_json="1"\nurl="2"\ntokio={version="1",features=["rt","macros","net"]}\ntokio-tungstenite={version="0.28",features=["native-tls"]}\n`)
  await copyFile(resolve(here,'client-session.rs'),resolve(cargo,'src/main.rs'))
  await copyFile(resolve(transport,'Cargo.lock'),resolve(cargo,'Cargo.lock'))
  await run('cargo',['build','--offline','--manifest-path',resolve(cargo,'Cargo.toml')])
  const portSocket = createServer(); await new Promise(done=>portSocket.listen(0,'127.0.0.1',done))
  const port = portSocket.address().port; await new Promise(done=>portSocket.close(done))
  process.env.CORS_ORIGINS = `http://127.0.0.1:${port}`
  async function start() {
    backend = spawn(process.execPath,[resolve(here,'client-session-server.mjs'),server,output,String(port)],{cwd:work,env:process.env})
    children.add(backend)
    backend.stderr.on('data',chunk=>{log+=chunk})
    await new Promise((done,fail)=>{
      const timer=setTimeout(()=>fail(Error('Server readiness timed out')),15000)
      backend.stdout.on('data',chunk=>{log+=chunk;if(chunk.toString().includes('READY')){clearTimeout(timer);done()}})
      backend.once('exit',code=>{clearTimeout(timer);fail(Error(`Server exited ${code}`))})
    })
  }
  const executable=resolve(process.env.CARGO_TARGET_DIR ?? resolve(cargo,'target'),'debug/suite-client-session-probe')
  await start()
  const args=[`http://127.0.0.1:${port}/`,resolve(work,'session/session.json')]
  await run(executable,['login',...args])
  await stop(backend); children.delete(backend)
  await start()
  await run(executable,['logout',...args])
  const paths=[resolve(transport,'src/lib.rs'),resolve(here,'client-session.rs'),resolve(here,'client-session-server.mjs'),resolve(here,'client-session.mjs'),executable,resolve(output,'auth/auth.service.js'),resolve(output,'auth/auth.controller.js')]
  const hashes=[]
  for(const path of paths) hashes.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${path}`)
  await writeFile(resolve(evidence,'hashes.txt'),hashes.join('\n')+'\n')
  console.log('PASS production Rust transport + production Server auth module lifecycle (fixture WS echo; no GUI/chat acceptance)')
} finally {
  for(const child of children) await stop(child)
  await writeFile(resolve(evidence,'session.log'),log)
}
