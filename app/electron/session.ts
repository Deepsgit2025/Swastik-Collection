import type { SafeUser } from '../src/types/user.js'

/**
 * Server-side session store, one entry per renderer `WebContents.id`, set
 * only from a verified `auth:login` response inside main.ts — never from a
 * renderer-supplied argument. Every IPC handler that needs to know who's
 * calling (for a permission check, or just to require being logged in at
 * all) must look the caller up here via `getSession`/`requireSession` in
 * main.ts, not accept a `user`/`role` value as a plain argument from the
 * renderer. A compromised or patched renderer can pass anything it wants as
 * an argument, but it cannot make this map say it logged in as someone it
 * didn't. See CLAUDE.md's Tech conventions section — every future phase's
 * IPC channels (sales, payments, expenses, settings, ...) must follow this
 * same pattern, not just Parties.
 */
const sessions = new Map<number, SafeUser>()

export function setSession(senderId: number, user: SafeUser): void {
  sessions.set(senderId, user)
}

export function clearSession(senderId: number): void {
  sessions.delete(senderId)
}

export function getSession(senderId: number): SafeUser | null {
  return sessions.get(senderId) ?? null
}
