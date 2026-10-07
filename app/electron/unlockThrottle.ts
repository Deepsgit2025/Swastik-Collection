/**
 * Slows down repeated wrong guesses at the Owner password.
 *
 * New in 2026-08-27's change, and needed *because* of it: until then the login
 * form was the first thing on screen and whoever was typing at it had not been
 * handed a working app. Now the app is open at the counter all day and the
 * password is the only thing between anyone standing at it and Reports,
 * Settings, the Drive restore and the purge job. Unlimited instant guesses
 * against a password a shopkeeper chose is not a gate.
 *
 * Deliberately small: a per-window counter, a delay that grows after the fifth
 * miss, and a reset on success. No lockout, and no persistence across a
 * restart — locking the Owner out of their own shop because someone fat-
 * fingered it is a worse failure than a slow brute force on a machine that is
 * already sitting behind a shop counter, and a lockout that survived a restart
 * would have no way to be lifted. This raises the cost of guessing; it does not
 * pretend to make it impossible.
 */

/** Misses allowed at full speed before the delay starts. Generous — mistyping a password twice is ordinary. */
const FREE_ATTEMPTS = 5

/** Added per miss beyond the free ones, so the 6th waits 1s, the 7th 2s, and so on. */
const STEP_MS = 1_000

/** Ceiling, so a forgotten password never means an unusable prompt. */
const MAX_DELAY_MS = 15_000

const failures = new Map<number, number>()

/** How long this window must wait before its next attempt is even considered. */
export function unlockDelayMs(senderId: number): number {
  const misses = failures.get(senderId) ?? 0
  if (misses <= FREE_ATTEMPTS) return 0
  return Math.min((misses - FREE_ATTEMPTS) * STEP_MS, MAX_DELAY_MS)
}

export function recordUnlockFailure(senderId: number): void {
  failures.set(senderId, (failures.get(senderId) ?? 0) + 1)
}

/** Called on a correct password — the next mistype starts from zero again. */
export function clearUnlockFailures(senderId: number): void {
  failures.delete(senderId)
}

export function delay(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve()
}
