import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
// Keep integration tests independent of concurrent Nest builds/watchers.
import { execFileSync } from 'node:child_process'
import { accessSync, mkdirSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

export function buildTestServer(server, work) {
  const output = resolve(work, 'server-dist')
  mkdirSync(output, { recursive: true })
  writeFileSync(
    resolve(output, 'package.json'),
    JSON.stringify({ type: 'module' }),
  )
  symlinkSync(
    resolve(server, 'node_modules'),
    resolve(output, 'node_modules'),
    'junction',
  )
  execFileSync(
    process.execPath,
    [
      resolve(server, 'node_modules/typescript/bin/tsc'),
      '--project',
      resolve(server, 'tsconfig.build.json'),
      '--outDir',
      output,
      '--incremental',
      'false',
    ],
    { cwd: server, stdio: 'pipe' },
  )
  for (const name of ['common-passwords.txt', 'SecLists-LICENSE.txt'])
    copyFileSync(resolve(server, 'src/auth', name), resolve(output, 'auth', name))
  const database = resolve(work, 'auth.db')
  const token = createHash('sha256').update('isolated aixand browser session fixture').digest('base64url')
  execFileSync(process.execPath, ['--input-type=module', '-e', `
    const [storeUrl, passwordUrl, file, token, pending] = process.argv.slice(1);
    const { initializeAuthDatabase, AuthStore, tokenHash } = await import(storeUrl);
    const { hashPassword } = await import(passwordUrl);
    if (pending !== '1') {
      initializeAuthDatabase(file);
      const store = new AuthStore(file);
      store.db.prepare("UPDATE workspace_auth SET state='configured', password_hash=?, credential_version=1 WHERE id=1").run(await hashPassword('isolated Suite password 9274!'));
      const now=Date.now();
      store.db.prepare('INSERT INTO auth_sessions VALUES (?, 1, ?, ?, ?, ?)').run(tokenHash(token), 'isolated-csrf-fixture', now, now, now+12*60*60*1000);
      store.close();
    }
  `, pathToFileURL(resolve(output, 'auth/store.js')).href,
    pathToFileURL(resolve(output, 'auth/password.js')).href, database, token,
    process.env.AIXAND_TEST_SETUP_PENDING ?? '0'], { stdio: 'pipe' })
  process.env.AIXAND_AUTH_DATABASE = database
  process.env.AIXAND_AUTH_DEV_HTTP = '1'
  process.env.AIXAND_TRUST_PROXY = ''
  const main = resolve(output, 'main.js')
  accessSync(main)
  return main
}

export function testAuthEnvironment() {
  return { AIXAND_AUTH_DATABASE: process.env.AIXAND_AUTH_DATABASE, AIXAND_AUTH_DEV_HTTP: '1', AIXAND_TRUST_PROXY: '' }
}
export async function authenticateTestPage(page, url) {
  await page.context().addCookies([{
    name: 'aixand-dev-session',
    value: createHash('sha256').update('isolated aixand browser session fixture').digest('base64url'),
    url: new URL(url).origin, httpOnly: true, sameSite: 'Strict',
  }])
}
