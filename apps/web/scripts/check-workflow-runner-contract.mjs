import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'

const require = createRequire(import.meta.url)
const ts = require('typescript')
require.extensions['.ts'] = (module, filename) => module._compile(ts.transpileModule(readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText, filename)
const web = fileURLToPath(new URL('../', import.meta.url))
const { compileCanvas } = require(resolve(web, 'src/workflows/builder/compileCanvas.ts'))
const { sequentialDraft, brainImplementerDraft, projectAuditDraft, makeNode, parseDraft, serializeDraft } = require(resolve(web, 'src/workflows/builder/model.ts'))
const { compileNativeCanvas } = require(resolve(web, 'src/workflows/builder/nativeGraph.ts'))
const captured = projectAuditDraft()
captured.native = { resourceCapture: 'workflow', permissionMode: 'read-only', profileSelection: { mode: 'auto' } }
const restored = parseDraft(serializeDraft(captured))
assert.deepEqual(restored.native, captured.native)
assert.equal(compileNativeCanvas(restored).resourceCapture, 'workflow')
assert.equal(compileCanvas(restored, 'capture-check').workflow.context.resourceCapture, 'workflow')
assert.throws(() => parseDraft(JSON.stringify({ ...captured, native: { resourceCapture: 'unknown' } })))
assert.throws(() => parseDraft(JSON.stringify({ ...captured, native: { resourceCapture: ['workflow'] } })))
const manual = projectAuditDraft()
const ids = Object.fromEntries(manual.nodes.map((node, index) => [node.id, `1${index}000000-0000-4000-8000-000000000000`]))
manual.nodes = manual.nodes.map((node) => ({ ...node, id: ids[node.id] }))
manual.edges = manual.edges.map((edge) => ({ ...edge, source: ids[edge.source], target: ids[edge.target] }))
const mixed = brainImplementerDraft()
const chat = makeNode('chat', { x: 900, y: 0 })
chat.data.prompt = 'Plan follow-up tasks from the implementer’s completed report.'
const main = makeNode('human-inbox', { x: 1200, y: 0 })
mixed.nodes.push(chat, main)
mixed.edges.push(...[[mixed.nodes.find((node) => node.data.kind === 'result').id, chat.id], [chat.id, main.id]]
  .map(([source, target]) => ({ id: `${source}-${target}`, source, target, sourceHandle: 'out', targetHandle: 'in' })))
const directory = mkdtempSync(join(tmpdir(), 'aixand-canvas-contract-'))
const fixtures = join(directory, 'fixtures')
try {
  mkdirSync(fixtures)
  for (const [name, draft] of [['sequence', sequentialDraft()], ['brain', brainImplementerDraft()], ['audit', projectAuditDraft()], ['manual', manual], ['mixed', mixed]]) {
    writeFileSync(join(fixtures, `${name}.json`), JSON.stringify(compileCanvas(draft, 'contract-check').workflow))
  }
  const frozen = compileCanvas(captured, 'capture-check').workflow
  frozen.context.profileRequirements = { schema: 'agent-manager/resource-request-2', inherit_profile: false,
    instructions: { mode: 'off' }, skills: { add: [] }, mcp: { add: [] } }
  writeFileSync(join(fixtures, 'captured.json'), JSON.stringify(frozen))
  const result = spawnSync('cargo', ['test', '--locked', '--manifest-path', resolve(web, '../../workflow/runner/Cargo.toml'), '--test', 'graph', 'compiled_canvas_programs_pass_authoritative_preflight', '--', '--ignored'], {
    stdio: 'inherit', env: { ...process.env, CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR || join(directory, 'target'), RUNNER_CANVAS_FIXTURES: fixtures },
  })
  if (result.error) throw result.error
  process.exitCode = result.status ?? 1
} finally {
  rmSync(directory, { recursive: true, force: true })
}
