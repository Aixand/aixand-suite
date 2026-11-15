import { useEffect, useState } from 'react'
import { Button } from 'bbb-design'
import type { AgentJob } from './client'
import type { AgentsModel } from './model'

type Challenge = { verificationUrl: string; userCode: string }

export function LoginChallenge({ job, agents: a }: { job: AgentJob; agents: AgentsModel }) {
  const [challenge, setChallenge] = useState<Challenge | null>(null)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState<'code' | 'link' | null>(null)
  const waiting = !job.result?.loginSaved && ['running', 'starting', 'uncertain'].includes(job.status)
    && job.structured && job.phase === 'awaiting-user'
  useEffect(() => {
    let current = true
    setChallenge(null); setError(''); setCopied(null)
    if (!waiting || a.status !== 'connected') return
    let loading = false
    const refresh = () => {
      if (loading) return
      loading = true
      void a.request<{ available: boolean; challenge?: Challenge }>('agent-login-challenge', { operationId: job.id })
        .then(result => { if (current) { setChallenge(result.available ? result.challenge ?? null : null); setError('') } })
        .catch((cause: unknown) => { if (current) { setChallenge(null); setError(cause instanceof Error ? cause.message : 'Could not load sign-in details.') } })
        .finally(() => { loading = false })
    }
    refresh()
    return () => { current = false }
  }, [job.id, job.phase, job.status, a.status, waiting])
  useEffect(() => { setCopied(null) }, [challenge?.verificationUrl])
  if (!waiting) return null
  let url: URL | undefined
  try { if (challenge) url = new URL(challenge.verificationUrl) } catch { /* Keep the terminal available for unsupported links. */ }
  const valid = url?.protocol === 'https:' && !url.username && !url.password && !url.hash
    && (!url.port || url.port === '443') && url.hostname === 'auth.openai.com'
  const code = challenge?.userCode
  return <section className="agents-login-challenge" aria-label="Provider sign-in">
    {error && <p role="alert">{error}</p>}
    {challenge && valid && code ? <>
      <p>Open the provider sign-in page and enter this code.</p>
      <code aria-label="Device code">{code}</code>
      <div className="ws-actions">
        <a className="bbb-button" href={challenge.verificationUrl} target="_blank" rel="noopener noreferrer">Continue to sign in</a>
        <Button variant="secondary" size="sm" onPress={() => {
          void navigator.clipboard.writeText(code).then(() => { setCopied('code'); setError('') })
            .catch(() => setError('Copy the displayed code manually.'))
        }}>{copied === 'code' ? 'Code copied' : 'Copy code'}</Button>
        <Button variant="secondary" size="sm" onPress={() => {
          void navigator.clipboard.writeText(challenge.verificationUrl).then(() => { setCopied('link'); setError('') })
            .catch(() => setError('Use the sign-in button’s context menu to copy its link.'))
        }}>{copied === 'link' ? 'Link copied' : 'Copy sign-in link'}</Button>
      </div>
    </> : <p>Waiting for sign-in details…</p>}
  </section>
}
