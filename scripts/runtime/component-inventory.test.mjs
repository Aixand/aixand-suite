import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { componentInventory, applicationAt, removalChoices, removalDataChoices } from './component-inventory.mjs'

test('inventory detects data without tools or an application and does not create a workspace', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'aixand-inventory-'))
  try {
    const home = join(temporary, 'home'), base = join(home, 'workspace'), root = join(temporary, 'runtime'), app = join(temporary, 'application')
    await mkdir(home)
    const input = { HOME: home, PATH: '' }
    const empty = await componentInventory(root, input, base, app)
    assert.equal(empty.found, false)
    assert.equal(empty.workspace.present, false)
    assert.equal(empty.application, null)
    await mkdir(join(home, '.aixand/carrier'), { recursive: true })
    await writeFile(join(home, '.aixand/carrier/carrier.db'), 'data')
    const found = await componentInventory(root, input, base, app)
    assert.equal(found.found, true)
    assert.equal(found.tools.length, 0)
    assert.equal(found.workspace.present, false)
    assert.equal(found.sharedData[0].id, 'tool-data:carrier_home')
    await mkdir(app)
    await writeFile(join(app, 'server-installation.json'), JSON.stringify({ schema: 1, application: 'org.aixand.server', directory: app, workspace: base }))
    assert.equal(applicationAt(app).workspace, base)
    await writeFile(join(app, 'server-installation.json'), JSON.stringify({ schema: 1, application: 'org.other', directory: app, workspace: base }))
    assert.throws(() => applicationAt(app), /invalid/)
  } finally { await rm(temporary, { recursive: true, force: true }) }
})

test('tool removal keeps application data separate and unavailable components are excluded', () => {
  const groups = removalChoices([
    { id: 'workspace', available: true, shared: false },
    { id: 'private-tool-data', available: true, shared: false },
    { id: 'tool-data:runner_home', available: true, shared: true },
    { id: 'product:runner', available: true },
    { id: 'private-products', available: true },
    { id: 'provider:missing', available: true, present: false },
    { id: 'native:manual', available: false },
  ])
  assert.deepEqual(groups.software.map(item => item.id), ['product:runner', 'private-products'])
  assert.deepEqual(removalDataChoices(groups.data, 'tools').map(item => item.id), ['private-tool-data', 'tool-data:runner_home'])
  assert.ok(!removalDataChoices(groups.data, 'application').some(item => item.shared))
  assert.deepEqual(removalDataChoices(groups.data, 'both'), groups.data)
})
