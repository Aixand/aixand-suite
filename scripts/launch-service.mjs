import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'

// Read private application configuration only after Undercurrent has launched
// us. Its durable launch configuration contains paths and ordinary overrides,
// never the credential values in this file. execve preserves process identity,
// signals, exit status and the terminal while replacing this loader entirely.
try {
  const input = process.argv.slice(2)
  const separator = input.indexOf('--')
  const files = input.slice(0, separator)
  const [program, ...args] = input.slice(separator + 1)
  if (separator < 1 || !program) throw new Error('Invalid service launch arguments.')
  const inherited = { ...process.env }
  for (const file of files)
    if (file !== '-' && existsSync(file)) Object.assign(process.env, parseEnv(readFileSync(file, 'utf8')))
  Object.assign(process.env, inherited)
  process.execve(program, [program, ...args], process.env)
} catch (error) {
  console.error(`Suite service launch failed: ${error.message}`)
  process.exitCode = 1
}
