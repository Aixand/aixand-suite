import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createInterface } from 'node:readline'
import { test, expect, mockAuthentication, type Page, type WebSocketRoute } from './fixtures'
async function setup(page: Page) {
  await mockAuthentication(page)
  const root = await mkdtemp(resolve(tmpdir(), 'suite-mcp-ui-'))
  const worker = spawn(process.env.MANAGED_TEST_PYTHON!, ['-B', resolve('tests/mcp_managed_worker.py'), root, process.env.SUITE_MANAGED_BRIDGE!], { stdio: ['pipe','pipe','pipe'] })
  let id = 0, socket: WebSocketRoute | undefined
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  createInterface({ input: worker.stdout }).on('line', line => { const row = JSON.parse(line); const request = pending.get(row.id); pending.delete(row.id); row.error ? request?.reject(new Error(row.error)) : request?.resolve(row.result) })
  const call = <T,>(op: string, args: object = {}) => new Promise<T>((resolve, reject) => { const key = ++id; pending.set(key,{ resolve,reject }); worker.stdin.write(JSON.stringify({ id:key,op,args })+'\n') })
  await page.routeWebSocket('**/api/agents/ws', route => {
    socket=route; route.send(JSON.stringify({type:'ready'}))
    route.onMessage(raw => {
      const row = JSON.parse(String(raw)); if (!row.op) return
      let value: Promise<unknown> = Promise.resolve([])
      if (row.op.startsWith('mcp-managed-')) value=call(row.op,row.args)
      else if (row.op==='catalog') value=Promise.resolve({ profiles:[],auths:[],capabilities:[],cwd:root })
      else if (row.op==='mcp-catalog') value=Promise.resolve({servers:[]})
      else if (row.op==='sessions') value=Promise.resolve({runs:[],runtimeError:null})
      else if (row.op==='project-list') value=Promise.resolve([])
      void value.then(result=> { route.send(JSON.stringify({type:'result',id:row.id,result})); if (/mcp-managed-(apply|save|rollback|tracking)$/.test(row.op)) route.send(JSON.stringify({type:'mcps-changed'})) }).catch(error=>route.send(JSON.stringify({type:'error',id:row.id,message:error.message})))
    })
  })
  await page.goto('/#/agents/tools?publisher=fixture&resource=default')
  await expect(page.getByRole('button',{name:'Edit server',exact:true})).toBeVisible()
  return { call, async update() { await call('fixture-update'); socket?.send(JSON.stringify({type:'mcps-changed'})) }, async close() { worker.stdin.end(); await new Promise<void>(resolve=>{ if (worker.exitCode !== null) resolve(); else worker.once('exit',()=>resolve()) }); await rm(root,{recursive:true,force:true}) } }
}
test('MCP publisher reconciliation keeps the accepted configuration until applied', async ({page})=> {
 const backend=await setup(page)
 try {
  await backend.update()
  await expect(page.getByText('Publisher update needs review. Your customized version is still active.')).toBeVisible()
  await page.getByRole('button',{name:'Review update',exact:true}).click()
  await expect(page.getByRole('heading',{name:'Publisher update',exact:true})).toBeVisible()
  await page.getByRole('combobox',{name:'Choice for /definition/args',exact:true}).selectOption('publisher')
  await page.getByRole('button',{name:'Preview choices',exact:true}).click()
  await expect(page.getByText('0 unresolved conflict(s).')).toBeVisible()
  await page.getByRole('button',{name:'Apply reconciled update',exact:true}).click()
  const result=await backend.call<any>('fixture-content')
  expect(result.definition.args).toEqual(['publisher-2'])
  expect(result.resolution.reconciliation_required).toBe(false)
  await page.screenshot({path:test.info().outputPath('mcp-reconciled.png'),fullPage:true})
 } finally { await backend.close() }
})
test('a publisher update makes an MCP review stale while retaining choices',async ({page})=> {
 const backend=await setup(page)
 try {
  await backend.update(); await page.getByRole('button',{name:'Review update',exact:true}).click()
  const choice=page.getByRole('combobox',{name:'Choice for /definition/args',exact:true}); await choice.selectOption('managed')
  await backend.update()
  await expect(page.getByText('This resource changed. Your unsaved work is retained. Reload the comparison before applying.')).toBeVisible()
  await expect(choice).toHaveValue('managed')
  await expect(page.getByRole('button',{name:'Apply reconciled update',exact:true})).toBeDisabled()
  const result=await backend.call<any>('fixture-content');expect(result.definition.args).toEqual(['mine'])
 } finally { await backend.close() }
})

test('publisher registration fields are usable inside the shared configuration editor', async ({ page }) => {
 const backend = await setup(page)
 try {
  await page.getByRole('button', { name: 'MCP library actions', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Register publisher definition', exact: true }).click()
  await page.getByRole('textbox', { name: 'Publisher ID', exact: true }).fill('another-publisher')
  await page.getByRole('textbox', { name: 'Command', exact: true }).fill('python3')
  await page.getByRole('spinbutton', { name: 'Publisher revision (optional)', exact: true }).fill('5')
  await page.getByRole('button', { name: 'Save changes', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Edit server', exact: true })).toBeVisible()
  const result = await backend.call<any>('mcp-managed-resolve', { publisherId: 'another-publisher', resourceId: 'default' })
  expect(result.definition.command).toBe('python3')
  expect(result.resolution.baseline.revision).toBe(5)
 } finally { await backend.close() }
})
