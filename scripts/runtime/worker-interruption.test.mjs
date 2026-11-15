import { reserveActivation, withActivationAccess } from './activation.mjs'
import { start } from './runtime.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign, createHash } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { componentDigest, resolveComponentSelection, componentUpdateAction,
  } from './component-updates.mjs'

const target = 'linux-x86_64-gnu', now = Date.now(), digest = text => createHash('sha256').update(text).digest('hex')
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const trust = { schema: 1, enabled: true, origin: 'https://updates.example', keys: { test: publicKey.export({ type: 'spki', format: 'pem' }) } }
function signed(feed) { const payload = JSON.stringify(feed); return { schema: 1, keyId: 'test', payload, signature: sign(null, Buffer.from(payload), privateKey).toString('base64') } }
function feed(components, extra = {}) { return { schema: 2, product: 'aixand-suite-components', role: 'desktop', target, sequence: 1,
  publishedAt: new Date(now - 2000).toISOString(), issuedAt: new Date(now - 1000).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), components, ...extra } }
function candidate(id, release = 'a'.repeat(64), requires = {}) {
  const kinds = { web: 'assets', server: 'application', connect: 'service', vox: 'service', desktop: 'application', ir: 'library', runner: 'product' }
  return { version: '1.0.0', release, target, kind: kinds[id], activation: id === 'desktop' ? 'native-installer' : id === 'ir' ? 'consumer-build' : id === 'runner' ? 'product-engine' : 'runtime', requires, inputs: {},
    artifact: { url: 'https://updates.example/' + id + '.tar.gz', size: 1, sha256: 'c'.repeat(64), manifestSha256: 'd'.repeat(64) }, licenses: [{ id: 'Licence', url: 'https://updates.example/license', sha256: 'e'.repeat(64) }] }
}

async function fixture(t, { automaticDownload = false, multiple = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'suite-components-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const root = join(home, 'package'), base = join(home, 'workspace')
  await mkdir(join(root, 'scripts/release'), { recursive: true }); await mkdir(base)
  for (const file of ['artifacts.py', 'components.py']) await cp(resolve('scripts/release', file), join(root, 'scripts/release', file))
  await writeFile(join(root, 'update-config.json'), JSON.stringify(trust))
  await writeFile(join(root, 'components.json'), JSON.stringify({ schema: 1, role: 'desktop', target, components: { connect: candidate('connect') } }))
  await writeFile(join(root, 'sealed.txt'), 'sealed application')
  await writeFile(join(base, 'account-data'), 'private account')
  const artifactPath = join(home, 'web.tar.gz')
  const script = `import sys, json, hashlib, tarfile, io\nsys.path.insert(0,sys.argv[1])\nfrom artifacts import canonical, validate_manifest\ndata=b'fresh web runtime'\nm={'schema':1,'component':'web','version':'1.0.0','target':'${target}','kind':'assets','activation':'runtime','requires':{},'inputs':{},'source':{'revision':'a'*40,'dirty':False},'files':{'index.html':{'sha256':hashlib.sha256(data).hexdigest(),'size':len(data),'executable':False}}}\nm['release']=hashlib.sha256(canonical({k:v for k,v in m.items() if k!='source'})).hexdigest()\nvalidate_manifest(m)\nwith tarfile.open(sys.argv[2],'w:gz',format=tarfile.USTAR_FORMAT) as a:\n for name,body in [('component.json',canonical(m)),('payload/index.html',data)]:\n  e=tarfile.TarInfo(name);e.size=len(body);e.mode=0o644;a.addfile(e,io.BytesIO(body))\nprint(json.dumps(m))`
  const manifest = JSON.parse(execFileSync('python3', ['-B', '-c', script, join(root, 'scripts/release'), artifactPath], { encoding: 'utf8' }))
  const archive = await readFile(artifactPath)
  const item = { ...candidate('web', manifest.release), artifact: { url: 'https://updates.example/web.tar.gz', sha256: digest(archive), size: archive.length, manifestSha256: componentDigest(manifest) } }
  const value = feed({ web: item, ...(multiple ? { connect: candidate('connect') } : {}) }), envelope = signed(value)
  let active = [], running = false, stops = 0, starts = 0, failStart = false, fetches = 0
  const config = { root, base, input: { HOME: home }, env: { PATH: process.env.PATH }, tools: { python: execFileSync('which', ['python3'], { encoding: 'utf8' }).trim() } }
  const dependencies = { lifecycle: {
    status: async () => ({ services: [{ state: running ? 'running' : 'stopped' }] }),
    updateBlockers: async () => active,
    prepareUpdate: async () => { if (active.length) throw new Error('Active work during preparation') },
    stop: async () => { stops++; running = false },
    start: async () => { starts++; if (failStart) throw new Error('owning lifecycle failed'); running = true },
  }, fetch: async url => { fetches++; return new Response(url.endsWith('latest.json') ? JSON.stringify(envelope) : archive) } }
  const action = (name, input) => componentUpdateAction(config, name, input, dependencies)
  if (automaticDownload) await action('settings', { automaticDownload: true })
  return { home, root, base, config, dependencies, action, item, archive, envelope,
    active: value => { active = value }, running: value => { running = value }, failStart: value => { failStart = value },
    counts: () => ({ stops, starts, fetches }) }
}
async function ready(f) { await f.action('check'); await f.action('download'); return f.action('plan') }
function consent(plan) { return { confirmed: true, revision: plan.revision, acceptedLicenses: plan.licenses.map(i => i.sha256), restartConsent: true } }
async function launch(f, plan) {
  f.dependencies.launchWorker = async ({ job }) => { f.job = JSON.parse(await readFile(job, 'utf8')); return { outsideLifecycle: true, pid: process.pid } }
  return f.action('install', consent(plan))
}


import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { symlink, chmod } from 'node:fs/promises'
import { componentSelectionSnapshot, artifactTarget } from './updates.mjs'
// Hooks pause only after a real atomic publication in the child. No production hooks.
async function interrupt(t, script, path, match) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import fs from 'node:fs/promises'; import { syncBuiltinESMExports } from 'node:module';
    const rename = fs.rename;
    fs.rename = async (a,b) => { await rename(a,b); if (b === ${JSON.stringify(path)}) {
      const value = JSON.parse(await fs.readFile(b,'utf8'));
      if ((${match})(value)) { process.stdout.write('ready\\n'); await new Promise(() => setInterval(()=>{},1000)); }
    }};
    syncBuiltinESMExports(); ${script}
  `], { stdio: ['ignore','pipe','pipe'] });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') });
  let stderr = ''; child.stderr.on('data', b => { stderr += b });
  await new Promise((resolve,reject) => {
    const timer = setTimeout(()=>reject(new Error('worker pause timeout: '+stderr)),20000);
    child.stdout.once('data',()=>{clearTimeout(timer);resolve()});
    child.once('exit',()=>{clearTimeout(timer);reject(new Error('early exit: '+stderr))}); child.once('error',reject);
  });
  const published = await readFile(path,'utf8');
  const exited = once(child,'exit'); child.kill('SIGKILL'); assert.deepEqual(await exited,[null,'SIGKILL']);
  assert.equal(await readFile(path,'utf8'),published);
}
async function denied(base) {
  const file = join(base,'updates/activation.json'), before = await readFile(file,'utf8');
  assert.ok(JSON.parse(before).workerPid);
  await assert.rejects(withActivationAccess(base,null,()=>assert.fail('startup admitted')),/reserved/);
  await assert.rejects(start({base,input:{}}),/reserved/);
  await assert.rejects(reserveActivation(base,'rival','native'),/reserved/);
  assert.equal(await readFile(file,'utf8'),before);
}
for (const phase of ['installing','selection','completed']) test(`component worker SIGKILL after ${phase}`, {timeout:30000}, async t => {
  const f = await fixture(t); f.running(true); await launch(f,await ready(f));
  const selection = join(f.base,'config/component-selection.json');
  const path = phase === 'selection' ? selection : join(f.base,'software/components/jobs',f.job.operation,'recovery.json');
  const match = phase === 'selection' ? 'v => !!v.components.web' : `v => v.phase === '${phase}'`;
  const module = new URL('./component-update-worker.mjs',import.meta.url).href;
  await interrupt(t,`let running=true;const {runComponentWorker}=await import(${JSON.stringify(module)}); await runComponentWorker(${JSON.stringify(f.config)},${JSON.stringify(f.job)},{outsideLifecycle:true,lifecycle:{status:async()=>({services:[{state:running?'running':'stopped'}]}),updateBlockers:async()=>[],prepareUpdate:async()=>{},stop:async()=>{running=false},start:async()=>{running=true}}});`,path,match);
  await denied(f.base);
  const journal = JSON.parse(await readFile(join(f.base,'software/components/jobs',f.job.operation,'recovery.json'),'utf8'));
  assert.equal(journal.operation,f.job.operation); assert.equal(journal.recovery.selection,null);
  assert.equal(existsSync(selection),phase !== 'installing');
  if (phase !== 'installing') assert.equal(await readFile(join(resolveComponentSelection(f.root,f.base).paths.web,'index.html'),'utf8'),'fresh web runtime');
  assert.equal(await readFile(join(f.base,'account-data'),'utf8'),'private account');
});

{
const pair = generateKeyPairSync('ed25519'), pem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const keyId = createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex').slice(0, 16)
const trust = { schema: 1, enabled: true, origin: 'https://downloads.example.test', keys: { [keyId]: pem } }
const digest = value => createHash('sha256').update(value).digest('hex')
const packageBytes = Buffer.from('a verified update fixture')
function release(patch = {}) {
  return { schema: 1, apiProtocol: 1, product: 'aixand-server', version: '0.1.0-beta', sequence: 2, pathVersion: '0.1.0-beta.r2', notes: 'A tested update.',
    publishedAt: new Date(Date.now() - 1000).toISOString(), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(),
    artifacts: { [artifactTarget()]: { url: trust.origin + '/aixand-server/0.1.0-beta.r2/setup', size: packageBytes.length,
      sha256: digest(packageBytes), build: digest('new-runtime'), kind: 'server-setup', products: [], licenses: [] } }, ...patch }
}
function envelope(value = release()) {
  const payload = JSON.stringify(value)
  return { schema: 1, keyId, payload, signature: sign(null, Buffer.from(payload), pair.privateKey).toString('base64') }
}
async function fixture(callback, configured = true) {
  const directory = await mkdtemp(join(tmpdir(), 'aixand-updates-'))
  const root = join(directory, 'runtime'), base = join(directory, 'workspace')
  await mkdir(root); await mkdir(base)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: '0.1.0-beta', releaseSequence: 1, build: digest('old-runtime'), installation: { role: 'server', edition: 'distributed' } }))
  await writeFile(join(root, 'update-config.json'), JSON.stringify({ ...trust, enabled: configured }))
  const config = { root, base }
  try { await callback(config, directory) } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5 }) }
}


for(const phase of ['installing','restarting']) test(`native worker SIGKILL after ${phase}`,{timeout:30000},async t=>{
 await fixture(async(config,directory)=>{
    const jobs = join(config.base, 'updates/server'), jobDirectory = join(jobs, 'jobs/fixture')
    await mkdir(jobDirectory, { recursive: true }); await mkdir(join(config.root, 'node/bin'), { recursive: true })
    await symlink(process.execPath, join(config.root, 'node/bin/node'))
    await writeFile(join(config.base, 'history'), 'keep history and logins')
    await mkdir(join(config.base, 'config'))
    const previousSelection = { schema: 1, components: { web: { path: 'fixture', manifest: { inputs: { runtime: digest('old-runtime') } } } } }
    const selectionFile = join(config.base, 'config/component-selection.json')
    await writeFile(selectionFile, JSON.stringify(previousSelection))
    const selection = await componentSelectionSnapshot(config.base)
    const calls = join(directory, 'calls.jsonl')
    await writeFile(join(config.root, 'runtime.mjs'), `import{appendFileSync}from'node:fs'; const args=process.argv.slice(2); appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n'); if(args[0]==='updates')console.log(JSON.stringify({sessions:[]})); else if(args[0]==='start'&&false||args[0]==='prepare-update'&&false){console.error('fixture health or work check failed');process.exitCode=1}else console.log('{}');`)
    const installer = join(directory, 'installer.mjs'), packageFile = join(directory, 'setup')
    await writeFile(installer, `import{readFile,writeFile,mkdir,cp}from'node:fs/promises';import{join}from'node:path';const root=${JSON.stringify(config.root)};const backup=join(root,'../.previous-fixture');await cp(root,backup,{recursive:true});await writeFile(join(root,'manifest.json'),JSON.stringify({build:${JSON.stringify(digest('new-runtime'))},releaseSequence:2}));await writeFile(join(root,'../server-installation.json'),JSON.stringify({updateBackup:'.previous-fixture'}));`)
    await writeFile(packageFile, `#!/bin/sh\nexec '${process.execPath}' '${installer}' "$@"\n`); await chmod(packageFile, 0o700)
    const bytes = await readFile(packageFile), value = release()
    Object.assign(value.artifacts[artifactTarget()], { size: bytes.length, sha256: digest(bytes) })
    const signed = envelope(value)
    await writeFile(join(config.root, '../server-installation.json'), '{}')
    const operation = 'fixture-native-operation', jobFile = join(jobDirectory, 'job.json')
    await reserveActivation(config.base, operation, 'native')
    await writeFile(join(jobs, 'state.json'), JSON.stringify({ operation, job: jobFile, phase: 'preparing', operationPid: null, daily: true }))
    const job = { operation, config: { ...config, updateDirectory: jobs }, root: config.root, workspace: config.base, port: 18753, carrierPort: 18765,
      product: value.product, installedBuild: digest('old-runtime'), envelope: signed, trust, sequence: 2,
      componentSelectionDigest: selection.digest,
      artifact: value.artifacts[artifactTarget()], packageFile, wasRunning: true, env: { HOME: directory, PATH: process.env.PATH }, acceptedLicenses: [] }
    await writeFile(jobFile, JSON.stringify(job))
    execFileSync('python3',['-B','-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table evidence(value)'); c.execute(\"insert into evidence values ('retained')\"); c.commit(); c.close()",join(config.base,'evidence.db')]);
    const module = new URL('./update-worker.mjs',import.meta.url).href;
    await interrupt(t,`const {runUpdate}=await import(${JSON.stringify(module)});await runUpdate(${JSON.stringify(jobFile)});`,join(jobs,'state.json'),`v => v.phase === '${phase}'`);
    await denied(config.base);
    const state = JSON.parse(await readFile(join(jobs,'state.json'),'utf8'));
    assert.equal(state.phase,phase);
    const retained = JSON.parse(await readFile(state.componentSelectionBackup,'utf8'));
    assert.deepEqual(retained.selection,previousSelection);
    assert.equal(retained.digest,selection.digest);
    const snapshot = JSON.parse(await readFile(join(state.databaseBackup,'snapshot.json'),'utf8'));
    const row = snapshot.files.find(r=>r.file==='evidence.db'); assert.ok(row);
    const backupBytes = await readFile(join(state.databaseBackup,row.file)); assert.equal(digest(backupBytes),row.sha256);
    assert.equal(digest(await readFile(join(config.base,row.file))),row.sha256);
    const result = execFileSync('python3',['-B','-c',"import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('pragma integrity_check').fetchone()[0]); print(c.execute('select value from evidence').fetchone()[0])",join(state.databaseBackup,row.file)],{encoding:'utf8'});
    assert.equal(result,'ok\nretained\n');
    assert.deepEqual(JSON.parse(await readFile(selectionFile,'utf8')),phase==='installing'?previousSelection:{schema:1,components:{}});
    if(phase==='restarting') assert.equal(JSON.parse(await readFile(join(state.backup,'manifest.json'),'utf8')).build,digest('old-runtime'));
    assert.equal(await readFile(join(config.base,'history'),'utf8'),'keep history and logins');
 });
});
}
