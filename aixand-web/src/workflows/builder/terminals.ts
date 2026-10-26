import type { GraphWorkflow } from './compileCanvas'
import type { Workflow } from '../ir'
import type { CompiledCanvas } from './compile'
import type { JobResult } from './jobs'

export type AgentSession = {
  invocation: string
  run_id: string
  session_id: string
  provider: string
}
export type TerminalTarget = {
  invocation: string
  provider: string
  sessionId?: string
  runId?: string
}

// Resolve the compiled agent reference, including Send/Wait targeting an earlier
// agent. Node position, label, and whichever terminal is newest are irrelevant.
export function nodeTerminals(
  compiled: CompiledCanvas<Workflow | GraphWorkflow> | null,
  sessions: Record<string, AgentSession>,
  result: JobResult | null,
): Record<string, TerminalTarget> {
  if (!compiled) return {}
  const steps = ('format' in compiled.workflow ? compiled.workflow.workflow : compiled.workflow).body.steps
  if (!Array.isArray(steps)) return {}
  const targets: Record<string, TerminalTarget> = {}
  for (const step of steps) {
    if (step?.kind !== 'operation' || !step.inputs || !step.operation) continue
    const reference = step.inputs.agent
    const nodeId = compiled.invocations[step.id]
    const invocation = compiled.terminalAgents?.[nodeId] ?? (step.operation.id === 'aixand.agents.spawn'
      ? step.id
      : reference?.kind === 'ref' && reference.source === 'step'
        ? reference.step
        : '')
    const spawn = steps.find((entry) => entry?.id === invocation)
    if (!nodeId || spawn?.kind !== 'operation' || !spawn.inputs || spawn.operation?.id !== 'aixand.agents.spawn') continue
    const provider = spawn.inputs.provider
    const session = sessions[invocation]
    const runId = result?.result?.[`${invocation}_run_id`]
    targets[nodeId] = {
      invocation,
      provider: provider?.kind === 'literal' && typeof provider.value === 'string'
        ? provider.value : 'codex',
      sessionId: session?.session_id,
      runId: session?.run_id ?? (typeof runId === 'string' ? runId : undefined),
    }
  }
  return targets
}
