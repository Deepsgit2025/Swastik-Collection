import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { SafeUser } from '../types/user.ts'

type UnlockOutcome = { ok: true } | { ok: false; error: string; retryAfterMs: number }

interface AuthContextValue {
  /**
   * Who this window currently is: the counter, or the Owner while an
   * Owner-only module is open. Null only during the one round trip below.
   */
  user: SafeUser | null
  /** True while `startSession()` is still in flight. `user` is null then, but that means "not known yet", not "nobody". */
  starting: boolean
  /** Whether this window is currently raised to the Owner. Convenience over `user?.role === 'owner'`, and the name says what it means here. */
  elevated: boolean
  /** Ask the main process to raise this window to the Owner. Rejects nothing — a wrong password comes back as `{ ok: false }`. */
  unlock: (password: string) => Promise<UnlockOutcome>
  /** Drop back to the counter. Called when an Owner-only screen unmounts. */
  lock: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * Holds the session as plain React state — nothing is written to
 * localStorage, sessionStorage, or the URL.
 *
 * **Nobody logs in any more** (client decision, 2026-08-27: "remove salesman
 * login"). The app opens straight into billing as the counter, and the Owner
 * password is what stands in front of the modules a salesman must not reach.
 * So this context no longer tracks *whether* someone is signed in — something
 * always is — but *what this window is currently allowed to do*.
 *
 * What has not changed, and must not: the role is never decided here. `user`
 * is whatever the main process hands back from `startSession`/`unlockOwner`/
 * `lockSession`, each of which resolves the identity from the database
 * itself. Nothing client-side — including a hand-edited hash or a patched
 * bundle — can make `user.role` say `owner`, because the value does not
 * originate here and the permission checks that matter do not read it. They
 * read the main process's own session map (electron/session.ts), which only
 * a correct password changes.
 *
 * That is the reason `elevated` is safe to render UI from while still being
 * only a hint: a renderer that forced it true would show the Owner's screens
 * and get a `PermissionError` from every channel behind them.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SafeUser | null>(null)
  const [starting, setStarting] = useState(true)
  /** Who this window is when it is not elevated, so `lock` can drop back to it without waiting on a round trip. */
  const counterRef = useRef<SafeUser | null>(null)

  // Runs once on mount, before anything renders a route. There is nothing to
  // fall back to if it fails — without a session every IPC call throws "Not
  // authenticated" — so a failure is left visible as `user === null` rather
  // than swallowed into a login form that no longer exists.
  useEffect(() => {
    let cancelled = false
    window.api
      .startSession()
      .then((counter) => {
        if (cancelled) return
        counterRef.current = counter
        setUser(counter)
      })
      .catch(() => {
        /* Nothing to recover to — `user` stays null and the shell renders empty. */
      })
      .finally(() => {
        if (!cancelled) setStarting(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const unlock = useCallback(async (password: string): Promise<UnlockOutcome> => {
    const result = await window.api.unlockOwner(password)
    if (!result.ok) {
      return { ok: false, error: result.error, retryAfterMs: result.retryAfterMs }
    }
    setUser(result.user)
    return { ok: true }
  }, [])

  /**
   * Drops back to the counter — **locally first, then in the main process**.
   *
   * The optimistic local update is not a nicety. `lock()` is called from a
   * route's unmount cleanup, and the next route mounts in the same commit,
   * long before an IPC round trip could answer. Waiting for the answer meant
   * navigating Reports → Settings rendered Settings *unlocked* for as long as
   * that round trip took, because `elevated` was still true when it mounted —
   * the gate held on the first module and let the second one through.
   *
   * Clearing the flag synchronously errs the safe way: the worst case if the
   * main-process call then fails is a window that looks locked while the
   * session behind it is still the Owner, which grants nothing on its own —
   * every screen has to be opened through the prompt to be rendered at all,
   * and the next navigation calls this again.
   *
   * Resilient about the round trip for the same reason: a cleanup has nowhere
   * to surface a rejection and no user action to retry it.
   */
  const lock = useCallback(async () => {
    setUser((current) => (current?.role === 'owner' ? counterRef.current : current))
    try {
      setUser(await window.api.lockSession())
    } catch {
      /* Nothing useful to show from a cleanup; the next navigation tries again. */
    }
  }, [])

  const value = useMemo(
    () => ({ user, starting, elevated: user?.role === 'owner', unlock, lock }),
    [user, starting, unlock, lock],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within an AuthProvider')
  return ctx
}
