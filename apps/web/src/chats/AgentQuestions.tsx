import { useState } from 'react'
import { Button, Icon, TextField } from 'bbb-design'
import type { ChatRequest } from './model'

export function AgentQuestions({ request, disabled, onAnswer }: {
  request: ChatRequest
  disabled: boolean
  onAnswer: (requestId: string, values: { answers: Record<string, string> }) => Promise<void>
}) {
  const questions = request.params.questions ?? []
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [step, setStep] = useState(0)
  const [custom, setCustom] = useState<Record<string, boolean>>({})
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  const question = questions[step]
  if (!question) return null
  const locked = disabled || sending
  const options = question.options ?? []
  const allowCustom = !options.length || request.method === 'sdk/question' || question.isOther === true
  return <form className="command-agent-request command-agent-questions" aria-label="Agent questions" onSubmit={event => {
    event.preventDefault()
    if (locked || !answers[question.id]?.trim()) return
    if (step < questions.length - 1) { setStep(step + 1); return }
    if (questions.some(row => !answers[row.id]?.trim())) return
    setSending(true); setError('')
    void onAnswer(request.requestId, { answers }).catch(cause => {
      setError(cause instanceof Error ? cause.message : 'Could not send your answers. Please try again.')
      setSending(false)
    })
  }}>
    <div className="command-request-heading"><Icon name="user-round" /><strong>A question for you</strong>
      {questions.length > 1 && <span>{step + 1} of {questions.length}</span>}</div>
    {question.header && <strong>{question.header}</strong>}
    <p id={`question-${request.requestId}-${question.id}`}>{question.question}</p>
    {options.length > 0 && <div className="command-question-options" role="group" aria-labelledby={`question-${request.requestId}-${question.id}`}>
      {options.map(option => <Button key={option.label} variant="ghost" disabled={locked} aria-label={option.label}
        aria-pressed={!custom[question.id] && answers[question.id] === option.label} onPress={() => {
          setCustom(previous => ({ ...previous, [question.id]: false }))
          setAnswers(previous => ({ ...previous, [question.id]: option.label }))
        }}><span><strong>{option.label}</strong>{option.description && <span>{option.description}</span>}</span></Button>)}
      {allowCustom && <Button variant="ghost" disabled={locked} aria-pressed={Boolean(custom[question.id])} onPress={() => {
        setCustom(previous => ({ ...previous, [question.id]: true }))
        setAnswers(previous => ({ ...previous, [question.id]: '' }))
      }}>Write my own answer</Button>}
    </div>}
    {allowCustom && (!options.length || custom[question.id]) && <TextField label="Your answer" type={question.isSecret ? 'password' : 'text'}
      value={answers[question.id] ?? ''} onChange={event => setAnswers(previous => ({ ...previous, [question.id]: event.target.value }))} disabled={locked} />}
    {error && <p role="alert">{error}</p>}
    <div className="command-answer-options">
      {step > 0 && <Button variant="ghost" disabled={locked} onPress={() => setStep(step - 1)}>Back</Button>}
      <Button type="submit" disabled={locked || !answers[question.id]?.trim()}>{sending ? 'Sending answers…' : step < questions.length - 1 ? 'Next question' : 'Send answers'}</Button>
    </div>
  </form>
}
