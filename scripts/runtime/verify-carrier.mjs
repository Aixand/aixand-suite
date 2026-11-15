import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

// Exercise the authenticated Suite bridge, not just carrier.cli's health route.
export async function verifyCarrier(WebSocket, address, cookie) {
  const socket = new WebSocket(address.replace('http:', 'ws:') + '/api/carrier/ws',
    { origin: address, headers: { Cookie: cookie } })
  const pending = new Map()
  let readyResolve, readyReject
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  const timer = setTimeout(() => readyReject(new Error('Carrier bridge did not become ready')), 20_000)
  const fail = error => {
    clearTimeout(timer)
    readyReject(error)
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
  }
  socket.on('error', fail)
  socket.on('close', () => fail(new Error('Carrier bridge disconnected during verification')))
  socket.on('message', raw => {
    const value = JSON.parse(raw.toString())
    if (value.type === 'ready') { clearTimeout(timer); readyResolve() }
    if (value.type === 'fatal') fail(new Error(value.message))
    const item = pending.get(value.id)
    if (item) {
      clearTimeout(item.timer); pending.delete(value.id)
      if (value.type === 'error') item.reject(new Error(value.message))
      else item.resolve(value.result)
    }
  })
  function request(op, args = {}) {
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Carrier ${op} timed out`)) }, 15_000)
      pending.set(id, { resolve, reject, timer })
      socket.send(JSON.stringify({ id, op, args }))
    })
  }
  try {
    await ready
    let snapshot
    const deadline = Date.now() + 20_000
    do {
      snapshot = await request('snapshot', { mailbox: 'user', view: 'Pending', search: '连接 ✓', limit: 1, offset: 0 })
      if (snapshot.status.connected && !snapshot.status.syncing) break
      await delay(100)
    } while (Date.now() < deadline)
    assert.equal(snapshot.status.connected, true, snapshot.status.error || 'Carrier did not synchronize')
    assert.equal(snapshot.status.syncing, false)
    assert.ok(snapshot.status.last_sync)
    assert.equal(snapshot.status.agent_configured, true, 'Carrier bridge must use the Suite SDK environment')
    assert.ok(Array.isArray(snapshot.messages))
    assert.ok((await request('mailboxes')).some(mailbox => mailbox.id === 'user'))
    return snapshot.status
  } finally {
    clearTimeout(timer)
    socket.close()
  }
}
