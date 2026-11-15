import { useState } from 'react'
import { Button, Checkbox, TextField } from 'bbb-design'

export type PasswordInput = { password: string; confirmation: string }

export function PasswordForm({
  setup,
  busy = false,
  preview = false,
  onSubmit,
}: {
  setup: boolean
  busy?: boolean
  preview?: boolean
  onSubmit: (input: PasswordInput) => boolean | Promise<boolean>
}) {
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [visible, setVisible] = useState(false)
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        if (busy) return
        if (await onSubmit({ password, confirmation })) {
          setPassword('')
          setConfirmation('')
        }
      }}
      autoComplete={preview ? 'off' : undefined}
    >
      <TextField
        label="Password"
        type={visible ? 'text' : 'password'}
        autoComplete={
          preview ? 'off' : setup ? 'new-password' : 'current-password'
        }
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        required
        disabled={busy}
      />
      {setup && (
        <>
          <TextField
            label="Confirm password"
            type={visible ? 'text' : 'password'}
            autoComplete={preview ? 'off' : 'new-password'}
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            required
            disabled={busy}
          />
          <p className="auth-hint">
            Use 15–128 characters. Spaces and Unicode are welcome.
          </p>
        </>
      )}
      <Checkbox
        label="Show password"
        isSelected={visible}
        onChange={setVisible}
        disabled={busy}
      />
      <Button type="submit" disabled={busy}>
        {busy ? 'Please wait…' : setup ? 'Create password' : 'Sign in'}
      </Button>
    </form>
  )
}
