import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const command = process.argv[2]
if (process.argv.length !== 3 || !['build', 'serve'].includes(command)) {
  console.error('Usage: node scripts/production.mjs build|serve')
  process.exit(1)
}

function run(program, args, cwd) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(program, args, { cwd, stdio: 'inherit', env: {
      ...process.env, ...(command === 'serve' ? { NODE_ENV: 'production' } : {}),
    } })
    const stop = signal => { if (!child.killed) child.kill(signal) }
    const interrupt = () => stop('SIGINT')
    const terminate = () => stop('SIGTERM')
    process.on('SIGINT', interrupt)
    process.on('SIGTERM', terminate)
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      process.off('SIGINT', interrupt)
      process.off('SIGTERM', terminate)
      if (code === 0 || signal === 'SIGINT' || signal === 'SIGTERM') resolveRun()
      else reject(new Error(`${program} exited with ${code ?? signal}`))
    })
  })
}

try {
  if (command === 'build') {
    const npm = process.env.npm_execpath
    const runNpm = (directory, script) => npm
      ? run(process.execPath, [npm, 'run', script], directory)
      : process.platform === 'win32'
        ? run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run ' + script], directory)
        : run('npm', ['run', script], directory)
    await runNpm(join(root, 'aixand-web'), 'build')
    await runNpm(join(root, 'aixand-server'), 'build')
    console.log('Production build ready. Start with: ./dev.sh serve --production')
  } else {
    const entry = join(root, 'aixand-server/dist/production-main.js')
    if (!existsSync(entry)) throw new Error('Build production first: node scripts/production.mjs build')
    await run(process.execPath, [entry], join(root, 'aixand-server'))
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
}
