// Run existing mocked UI suites with a disposable Vite cache/config wrapper.
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const web = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const suite = process.argv[2]
if (!['onboarding', 'recovery'].includes(suite)) throw new Error('Expected onboarding or recovery')
const work = await mkdtemp(resolve(tmpdir(), 'suite-browser-ui-'))
try {
  const config = resolve(work, 'playwright.config.ts')
  await writeFile(config, `import base from ${JSON.stringify(resolve(web, `playwright.${suite}.config.ts`))};
export default { ...base, testDir: ${JSON.stringify(resolve(web, 'tests'))},
  outputDir: ${JSON.stringify(resolve(web, `test-results/${suite}-contained`))},
  webServer: { ...base.webServer, cwd: ${JSON.stringify(web)},
    command: ${JSON.stringify(`"${process.execPath}" scripts/test-vite-live.mjs --host 127.0.0.1 --port ${suite === 'onboarding' ? 5240 : 5237} --strictPort`)} } };
`)
  const result = spawnSync(process.execPath, [resolve(web, 'node_modules/@playwright/test/cli.js'),
    'test', '--config', config, '--reporter=line'], { cwd: web, env: process.env, stdio: 'inherit' })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  await rm(work, { recursive: true, force: true })
}
