import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { useAuth } from './AuthContext.tsx'
import { OwnerPasswordPrompt } from './OwnerPasswordPrompt.tsx'

export interface OwnerGateOptions {
  /** What is about to happen, in the dialog's heading - "Delete party", "Save shop details". */
  title: string
  /** One line of consequence. Worth writing for anything that cannot be undone. */
  description?: string
}

interface Pending {
  options: OwnerGateOptions
  action: () => Promise<void> | void
}

/**
 * The Owner password in front of an **action** rather than a screen (client
 * decision, 2026-09-19: "remove the Owner lock, but make sure no one can delete
 * an entry without the Owner password").
 *
 * Every screen is open to the counter now, so looking at Parties, Reports or
 * Settings needs nothing. What needs the password is changing or destroying
 * something on them: it is asked for when the button is clicked, the action
 * runs while this window is the Owner, and the window drops straight back to
 * the counter when it finishes - success or failure - so the elevation never
 * outlives the one thing it was granted for.
 *
 *   const { run, gate } = useOwnerGate()
 *   ...
 *   <button onClick={() => run({ title: 'Delete party' }, () => deleteIt())}>
 *   ...
 *   {gate}
 *
 * `gate` has to be rendered somewhere in the component using the hook; it is
 * `null` until `run` is called.
 *
 * **This is how an Owner asks, not the security boundary** - the same
 * statement `OwnerPasswordPrompt` makes about itself. Unlocking changes the
 * *main process's* session, and every write function still asserts its own
 * permission against that session (`src/db/permissions.ts`), so a renderer
 * that skipped this dialog would still be the counter to every write channel
 * and get a `PermissionError`.
 *
 * The action is responsible for its own error display, exactly as it was
 * before being wrapped: whatever it caught and showed before it still does.
 * Anything it lets escape is logged here rather than lost, after the window has
 * been locked again.
 */
export function useOwnerGate(): { run: (options: OwnerGateOptions, action: () => Promise<void> | void) => void; gate: ReactNode } {
  const { lock } = useAuth()
  const [pending, setPending] = useState<Pending | null>(null)

  const run = useCallback((options: OwnerGateOptions, action: () => Promise<void> | void) => {
    setPending({ options, action })
  }, [])

  const handleUnlocked = useCallback(async () => {
    const current = pending
    if (!current) return
    try {
      await current.action()
    } catch (err) {
      console.error('[owner-gate] the action failed after unlocking:', err)
    } finally {
      // Locked before the dialog closes, so there is no frame in which the
      // dialog is gone and the window is still the Owner.
      await lock()
      setPending(null)
    }
  }, [lock, pending])

  const gate = pending ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={pending.options.title}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-auto bg-slate-900/50 p-6"
    >
      <OwnerPasswordPrompt
        title={pending.options.title}
        description={pending.options.description ?? 'Enter the Owner password to continue.'}
        onUnlocked={handleUnlocked}
        onCancel={() => setPending(null)}
      />
    </div>
  ) : null

  return { run, gate }
}
