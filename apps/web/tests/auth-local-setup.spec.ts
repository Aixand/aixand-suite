import { test, expect } from '@playwright/test'
import { request } from 'node:http'
import { networkInterfaces } from 'node:os'

test('Vite blocks forwarded setup even with a forged localhost Host and Origin', async ({
  request: api,
}) => {
  for (const path of [
    '/api/auth/setup',
    '/API/AUTH/SETUP/',
    '/api/auth/setup?first=1',
  ]) {
    const response = await api.post(path, {
      headers: {
        Host: 'localhost:5198',
        Origin: 'http://127.0.0.1:5198',
        'X-Forwarded-For': '127.0.0.1',
      },
      data: {
        password: 'remote password attempt 893!',
        confirmation: 'remote password attempt 893!',
      },
    })
    expect(response.status()).toBe(403)
    expect(await response.json()).toMatchObject({
      message: 'Create the first password locally on the Suite host.',
    })
  }
})

test('Vite checks the original network peer before proxying setup or status', async ({
  baseURL,
}) => {
  const address = Object.values(networkInterfaces())
    .flat()
    .find((value) => value?.family === 'IPv4' && !value.internal)?.address
  test.skip(!address, 'No non-loopback interface in this test environment')
  async function remote(path: string) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        new URL(path, baseURL),
        {
          localAddress: address,
          method: path.endsWith('status') ? 'GET' : 'POST',
          headers: {
            Host: 'localhost:5198',
            Origin: 'http://127.0.0.1:5198',
            'Content-Type': 'application/json',
          },
        },
        (response) => {
          let body = ''
          response.on('data', (chunk) => {
            body += chunk
          })
          response.on('end', () =>
            resolve({ status: response.statusCode ?? 0, body }),
          )
        },
      )
      req.on('error', reject)
      if (path.endsWith('status')) req.end()
      else
        req.end(
          JSON.stringify({
            password: 'remote password attempt 893!',
            confirmation: 'remote password attempt 893!',
          }),
        )
    })
  }
  expect((await remote('/api/auth/setup')).status).toBe(403)
  const status = await remote('/api/auth/status')
  expect(status.status).toBe(200)
  const value = JSON.parse(status.body)
  if (value.state === 'setup_pending') expect(value.setupAllowed).toBe(false)
})

test('the setup page explains local setup when the server reports remote access', async ({
  page,
}) => {
  await page.route('**/api/auth/session', (route) =>
    route.fulfill({ status: 401, json: { message: 'Sign in required' } }),
  )
  await page.route('**/api/auth/status', (route) =>
    route.fulfill({ json: { state: 'setup_pending', setupAllowed: false } }),
  )
  await page.goto('/')
  await expect(
    page.getByRole('heading', { name: 'Local setup required' }),
  ).toBeVisible()
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible()
})
