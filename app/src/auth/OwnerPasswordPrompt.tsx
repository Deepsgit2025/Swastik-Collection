import { useEffect, useRef, useState } from 'react'
import { useAuth } from './AuthContext.tsx'

/**
 * The Owner password prompt (client decision, 2026-08-27: "ask for password
 * when these modules are clicked").
 *
 * Used two ways: the sale screen renders it inline for the "stop retrying this
 * bill" override, and `useOwnerGate` renders it in a dialog in front of every
 * edit or delete on the screens that were Owner-locked until 2026-09-19.
 *
 * Asks for a password only, no username — there is one Owner, and this gets
 * typed many times a day at a counter with people waiting.
 *
 * **It is not the security boundary and does not pretend to be.** Unlocking
 * is `window.api.unlockOwner`, which changes the *main process's* session; a
 * renderer that skipped this component entirely would still be the counter to
 * every IPC channel it then called. What this is, is the way an Owner asks.
 */
export function OwnerPasswordPrompt({
  title,
  description,
  onUnlocked,
  onCancel,
  cancelLabel = 'Cancel',
}: {
  title: string
  description?: string
  onUnlocked?: () => void
  onCancel?: () => void
  cancelLabel?: string
}) {
  const { unlock } = useAuth()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** Non-zero while the throttle is making this window wait — see electron/unlockThrottle.ts. */
  const [cooldownMs, setCooldownMs] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Counts the cooldown down so the button says how long is left rather than
  // sitting inert for reasons the operator can't see.
  useEffect(() => {
    if (cooldownMs <= 0) return
    const timer = setTimeout(() => setCooldownMs((ms) => Math.max(0, ms - 1000)), 1000)
    return () => clearTimeout(timer)
  }, [cooldownMs])

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (busy || cooldownMs > 0) return

    setBusy(true)
    setError(null)
    try {
      const result = await unlock(password)
      if (result.ok) {
        // Cleared before handing control back, so the typed password does not
        // sit in React state behind whatever renders next.
        setPassword('')
        onUnlocked?.()
      } else {
        setError(result.error)
        setCooldownMs(result.retryAfterMs)
        setPassword('')
        inputRef.current?.focus()
      }
    } catch {
      setError('Could not check that password. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="mx-auto mt-10 flex w-full max-w-sm flex-col gap-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm"
    >
      <div>
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        {description && <p className="mt-1 text-sm text-slate-500">{description}</p>}
      </div>

      <label className="flex flex-col gap-1 text-sm text-slate-600">
        Owner password
        <input
          ref={inputRef}
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
        />
      </label>

      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
          {cooldownMs > 0 && ` Try again in ${Math.ceil(cooldownMs / 1000)}s.`}
        </p>
      )}

      <div className="flex gap-2">
        <button
          type="submit"
          disabled={busy || cooldownMs > 0 || password === ''}
          className="flex-1 rounded bg-slate-800 px-4 py-2 text-sm font-medium text-white hover:bg-slate-900 disabled:opacity-50"
        >
          {busy ? 'Checking…' : cooldownMs > 0 ? `Wait ${Math.ceil(cooldownMs / 1000)}s` : 'Unlock'}
        </button>
        {onCancel && (
          <button
            type="button"
            onClick={onCancel}
            className="rounded border border-slate-300 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100"
          >
            {cancelLabel}
          </button>
        )}
      </div>
    </form>
  )
}
