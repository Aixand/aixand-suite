import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isWaitingForSignIn, isPendingOperation, signinBlockerLabel } from '../src/agents/operationState.ts'

const job = { kind: 'profile-login', status: 'running', result: null }

test('preparing and blocked sign-ins never advertise an interactive terminal', () => {
  for (const phase of [undefined, 'preparing', 'waiting-for-work', 'verifying', 'finishing']) {
    assert.equal(isWaitingForSignIn({ ...job, phase }), false)
  }
  assert.equal(isWaitingForSignIn({ ...job, phase: 'awaiting-user' }), true)
})

test('queued sign-in remains cancellable work, not user-input readiness', () => {
  const queued = { ...job, status: 'queued', phase: 'waiting-for-work' }
  assert.equal(isPendingOperation(queued), true)
  assert.equal(isWaitingForSignIn(queued), false)
})

test('completion or saved login cannot leave a finish-signing-in prompt', () => {
  assert.equal(isWaitingForSignIn({ ...job, status: 'succeeded', phase: 'awaiting-user' }), false)
  assert.equal(isWaitingForSignIn({ ...job, phase: 'awaiting-user', result: { loginSaved: true } }), false)
})

test('unknown blockers remain uncertainty rather than idle', () => {
  assert.match(signinBlockerLabel('unknown_future_observation'), /Could not confirm/)
  assert.match(signinBlockerLabel('delegated_task'), /Child task/)
})
