// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  canStartSession,
  classifySocketState,
  initialWhatsAppState,
  isProfileLockedMessage,
  nextWhatsAppState,
} from './state.ts'

describe('nextWhatsAppState', () => {
  it('starts disconnected', () => {
    expect(initialWhatsAppState.status).toBe('disconnected')
  })

  it('moves to connecting on connect attempt, clearing any stale qr/error', () => {
    const next = nextWhatsAppState({ type: 'connecting' })
    expect(next).toEqual({ status: 'connecting', qrDataUrl: null, connectedNumber: null, lastError: null })
  })

  it('carries the QR data URL when a qr event arrives', () => {
    const next = nextWhatsAppState({ type: 'qr', qrDataUrl: 'data:image/png;base64,abc' })
    expect(next.status).toBe('qr')
    expect(next.qrDataUrl).toBe('data:image/png;base64,abc')
  })

  it('drops back to connecting (not connected) on authenticated — ready has not fired yet', () => {
    const next = nextWhatsAppState({ type: 'authenticated' })
    expect(next.status).toBe('connecting')
    expect(next.qrDataUrl).toBeNull()
  })

  it('becomes connected with the linked number on ready', () => {
    const next = nextWhatsAppState({ type: 'ready', number: '919876543210' })
    expect(next).toEqual({ status: 'connected', qrDataUrl: null, connectedNumber: '919876543210', lastError: null })
  })

  it('records auth_failure with the failure message', () => {
    const next = nextWhatsAppState({ type: 'auth_failure', message: 'session invalid' })
    expect(next).toEqual({ status: 'auth_failure', qrDataUrl: null, connectedNumber: null, lastError: 'session invalid' })
  })

  it('records disconnected with the reason, clearing the connected number', () => {
    const next = nextWhatsAppState({ type: 'disconnected', reason: 'NAVIGATION' })
    expect(next).toEqual({ status: 'disconnected', qrDataUrl: null, connectedNumber: null, lastError: 'NAVIGATION' })
  })

  // Restoring a session with a big backlog of missed messages stays in
  // 'connecting' for minutes; the percentage is what tells the Owner (and the
  // connect watchdog in client.ts) that it is working rather than wedged.
  it('stays connecting while reporting offline-sync progress', () => {
    const next = nextWhatsAppState({ type: 'loading', percent: 42 })
    expect(next.status).toBe('connecting')
    expect(next.loadingPercent).toBe(42)
  })

  it('clears the sync progress on every other event, so a stale percentage cannot linger', () => {
    expect(nextWhatsAppState({ type: 'connecting' }).loadingPercent).toBeUndefined()
    expect(nextWhatsAppState({ type: 'ready', number: '919876543210' }).loadingPercent).toBeUndefined()
    expect(nextWhatsAppState({ type: 'disconnected', reason: 'NAVIGATION' }).loadingPercent).toBeUndefined()
  })

  it('returns to a clean disconnected state on logged_out, ready for a fresh QR', () => {
    const next = nextWhatsAppState({ type: 'logged_out' })
    expect(next).toEqual(initialWhatsAppState)
  })
})

/**
 * The health poll's decision, which decides whether a session is torn down and
 * made to re-download its offline backlog. Untestable through client.ts (it
 * needs a real Electron/Puppeteer process), hence the pure split.
 */
describe('classifySocketState', () => {
  it('treats a connected socket as healthy', () => {
    expect(classifySocketState('CONNECTED')).toBe('healthy')
  })

  /**
   * The states this whole change is about: WhatsApp Web reconnecting itself.
   * Restarting over these costs the session and makes WhatsApp re-deliver
   * everything missed since, so the next connect is slower than this one.
   */
  it.each(['OPENING', 'PAIRING'])('treats %s as transient, not broken', (socketState) => {
    expect(classifySocketState(socketState)).toBe('transient')
  })

  it.each(['CONFLICT', 'TIMEOUT', 'UNPAIRED', 'UNPAIRED_IDLE', 'DEPRECATED_VERSION', 'PROXYBLOCK'])(
    'treats %s as broken',
    (socketState) => {
      expect(classifySocketState(socketState)).toBe('broken')
    },
  )

  it('treats a missing state as broken rather than assuming the best', () => {
    expect(classifySocketState(null)).toBe('broken')
    expect(classifySocketState(undefined)).toBe('broken')
    expect(classifySocketState('')).toBe('broken')
  })
})
/**
 * The guard that stands between a "start the session" request and a second
 * Chrome. Every one of these was reachable before it existed, and the first
 * two are the ones that actually reached the shop counter.
 */
describe('canStartSession', () => {
  const idle = { quitting: false, launching: false, hasClient: false, status: 'disconnected' } as const

  it('starts from an idle, disconnected session', () => {
    expect(canStartSession(idle)).toBe(true)
  })

  // The bug this whole change is about. 'qr' is not "nothing is running": a
  // Chrome is up, holding the profile, showing a code and waiting for a phone
  // — and the Connect screen shows a "Retry now" button the entire time.
  it('refuses while a QR is on screen, because that is a live browser', () => {
    expect(canStartSession({ ...idle, hasClient: true, status: 'qr' })).toBe(false)
  })

  // A failure publishes auth_failure and clears `client` immediately, but the
  // browser it belonged to takes up to ten seconds to actually die. A retry
  // clicked in that window used to launch straight into the locked profile.
  it('refuses while a written-off session still has a browser', () => {
    expect(canStartSession({ ...idle, hasClient: true, status: 'auth_failure' })).toBe(false)
    expect(canStartSession({ ...idle, hasClient: true, status: 'disconnected' })).toBe(false)
  })

  it('refuses a second attempt while one is still being prepared', () => {
    expect(canStartSession({ ...idle, launching: true })).toBe(false)
  })

  it('refuses once the app is quitting', () => {
    expect(canStartSession({ ...idle, quitting: true })).toBe(false)
  })

  it('stays a no-op for a session already connecting or connected', () => {
    expect(canStartSession({ ...idle, status: 'connecting' })).toBe(false)
    expect(canStartSession({ ...idle, status: 'connected' })).toBe(false)
  })

  it('allows a retry after a failure once the browser is gone', () => {
    expect(canStartSession({ ...idle, status: 'auth_failure' })).toBe(true)
  })
})

describe('isProfileLockedMessage', () => {
  // Verbatim from puppeteer-core's BrowserLauncher.js — the text that was on
  // the Connect screen, in a red box, in front of a customer.
  it('recognises the message Puppeteer produces for a held profile', () => {
    expect(
      isProfileLockedMessage(
        'The browser is already running for C:\\Users\\x\\AppData\\Roaming\\Swastik Collection Billing\\wwebjs_auth\\session. Use a different `userDataDir` or stop the running browser first.',
      ),
    ).toBe(true)
  })

  it("recognises Chrome's own wording for the same thing", () => {
    expect(isProfileLockedMessage('Failed to create a ProcessSingleton for your profile directory.')).toBe(true)
    expect(isProfileLockedMessage('The user data directory is already in use.')).toBe(true)
  })

  it('leaves every other failure alone, so its own text still reaches the log', () => {
    expect(isProfileLockedMessage('Protocol error: Target closed')).toBe(false)
    expect(isProfileLockedMessage('Failed to launch the browser process! spawn ENOENT')).toBe(false)
    expect(isProfileLockedMessage('')).toBe(false)
  })
})
