import type { WhatsAppState, WhatsAppStatus } from '../../src/types/whatsapp.js'

export const initialWhatsAppState: WhatsAppState = {
  status: 'disconnected',
  qrDataUrl: null,
  connectedNumber: null,
  lastError: null,
}

export type WhatsAppEvent =
  | { type: 'connecting' }
  | { type: 'qr'; qrDataUrl: string }
  | { type: 'authenticated' }
  | { type: 'loading'; percent: number }
  | { type: 'ready'; number: string }
  | { type: 'auth_failure'; message: string }
  | { type: 'disconnected'; reason: string }
  | { type: 'logged_out' }

/**
 * Pure mapping from a whatsapp-web.js Client event to the next status
 * snapshot — kept separate from client.ts (which does the actual Puppeteer
 * wiring and I/O) so the state machine itself can be unit-tested without a
 * live WhatsApp session. Each event fully determines the next state, so this
 * doesn't need the prior state as input.
 */
export function nextWhatsAppState(event: WhatsAppEvent): WhatsAppState {
  switch (event.type) {
    case 'connecting':
      return { status: 'connecting', qrDataUrl: null, connectedNumber: null, lastError: null }
    case 'qr':
      return { status: 'qr', qrDataUrl: event.qrDataUrl, connectedNumber: null, lastError: null }
    case 'loading':
      // Still connecting — but with something to show for it. Deliberately
      // the only branch that sets `loadingPercent`, so every other event
      // clears it back to "no progress being reported".
      return { status: 'connecting', qrDataUrl: null, connectedNumber: null, lastError: null, loadingPercent: event.percent }
    case 'authenticated':
      // QR scanned; whatsapp-web.js still needs to finish loading the
      // session before 'ready' fires, so stay in 'connecting' rather than
      // flipping straight to 'connected'.
      return { status: 'connecting', qrDataUrl: null, connectedNumber: null, lastError: null }
    case 'ready':
      return { status: 'connected', qrDataUrl: null, connectedNumber: event.number, lastError: null }
    case 'auth_failure':
      return { status: 'auth_failure', qrDataUrl: null, connectedNumber: null, lastError: event.message }
    case 'disconnected':
      return { status: 'disconnected', qrDataUrl: null, connectedNumber: null, lastError: event.reason }
    case 'logged_out':
      return { status: 'disconnected', qrDataUrl: null, connectedNumber: null, lastError: null }
  }
}

/**
 * How the health poll should read a WhatsApp Web socket state.
 *
 * Split out here, pure, for the same reason `nextWhatsAppState` is: it is the
 * decision that matters and it cannot be exercised through `client.ts`, which
 * needs a real Electron/Puppeteer process to import at all.
 *
 * The distinction that matters is `transient` vs `broken`. `OPENING`/`PAIRING`
 * mean WhatsApp Web is re-establishing its own connection and will heal on its
 * own; rebuilding the session over them is actively harmful, because every
 * teardown means WhatsApp has to re-deliver the backlog of messages that
 * arrived while we were gone — so an impatient restart is what turns a blip
 * into a multi-minute resync, and then into a longer one.
 */
export type SocketHealth = 'healthy' | 'transient' | 'broken'

const TRANSIENT_SOCKET_STATES = new Set(['OPENING', 'PAIRING'])

export function classifySocketState(socketState: string | null | undefined): SocketHealth {
  if (socketState === 'CONNECTED') return 'healthy'
  if (socketState && TRANSIENT_SOCKET_STATES.has(socketState)) return 'transient'
  return 'broken'
}

/**
 * Whether a start request may become an actual Chrome launch.
 *
 * Here, pure, for the same reason as everything else in this file: it is the
 * decision that matters and it cannot be exercised through `client.ts`, which
 * needs a real Electron/Puppeteer process to import at all. And this one has
 * been wrong in production — it is what put *"The browser is already running
 * for …\wwebjs_auth\session"* in a red box on the Connect screen.
 *
 * Chrome allows exactly one process per profile directory, so a second launch
 * doesn't queue or lose gracefully: it fails, and the message it fails with is
 * addressed to a programmer, not to whoever is at the counter. That makes this
 * a question with no forgiving answer — every "maybe" has to be a no.
 *
 * The status check alone used to be the whole rule, and it missed the case
 * that actually happened: **`qr` is a live session**. A Chrome is up, showing a
 * code and waiting for a phone — and the Connect screen offers a "Retry now"
 * button the whole time it is on display. One click was a second browser
 * against a held profile. `hasClient` is the rule that matters; the statuses
 * are kept because "already on its way up" is worth refusing by name.
 */
export interface SessionLaunchConditions {
  /** The app is shutting down; nothing new should be started. */
  quitting: boolean
  /** An attempt is already being prepared (it may not have a client object yet). */
  launching: boolean
  /** A `Client` exists — which means a Chrome exists, whatever the status says. */
  hasClient: boolean
  status: WhatsAppStatus
}

export function canStartSession(conditions: SessionLaunchConditions): boolean {
  if (conditions.quitting || conditions.launching) return false
  if (conditions.hasClient) return false
  return conditions.status !== 'connecting' && conditions.status !== 'connected'
}

/**
 * Whether a failed launch means *something else is holding Chrome's profile
 * directory*, rather than that this session is broken.
 *
 * Worth telling apart because the two want opposite handling: a broken session
 * is news, and a busy profile is housekeeping — sweep it and try again, with
 * nothing alarming said to anyone. Matched on text because Puppeteer raises it
 * as a plain `Error` with nothing to switch on; all three phrasings are
 * Chrome's or Puppeteer's own words for the one condition.
 */
export function isProfileLockedMessage(message: string): boolean {
  return /already running for|processsingleton|user data directory is already in use/i.test(message)
}
