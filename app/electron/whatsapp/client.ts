import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import electron from 'electron'
import QRCode from 'qrcode'
import whatsappWeb from 'whatsapp-web.js'
import type { WhatsAppState } from '../../src/types/whatsapp.js'
import {
  canStartSession,
  classifySocketState,
  initialWhatsAppState,
  isProfileLockedMessage,
  nextWhatsAppState,
} from './state.js'

const { Client, LocalAuth } = whatsappWeb
type MessageMedia = InstanceType<typeof whatsappWeb.MessageMedia>
type Message = whatsappWeb.Message
const { app } = electron

const traceFile = path.join(app.getPath('userData'), 'wa-timing.log')

function trace(msg: string): void {
  const line = `${new Date().toISOString()} ${msg}`
  console.log(`[trace] ${msg}`)
  try {
    fs.appendFileSync(traceFile, line + '\n')
  } catch {
    /* ignore */
  }
}

let readyPoll: ReturnType<typeof setInterval> | null = null

function stopReadyPoll(): void {
  if (readyPoll) {
    clearInterval(readyPoll)
    readyPoll = null
  }
}

let client: InstanceType<typeof Client> | null = null
let state: WhatsAppState = initialWhatsAppState
let listeners: Array<(state: WhatsAppState) => void> = []
let ackListeners: Array<(waMessageId: string, ack: number) => void> = []

// Auto-reconnect: the Owner should never have to click "Retry connect" for an
// ordinary drop (network blip, WhatsApp Web housekeeping restart, etc.) — see
// CLAUDE.md "always connected, never a manual step" decision. Backs off up to
// 30s so a genuinely offline machine doesn't spin a tight retry loop forever.
// Reset to the front of the list on every successful 'ready'. A manual
// "Retry connect" click (startWhatsAppClient()) still works immediately on
// top of this, since it's guarded by the same idempotency check.
const RECONNECT_DELAYS_MS = [2000, 5000, 10000, 20000, 30000]
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | null = null
let quitting = false

/**
 * The two things that make a second Chrome impossible.
 *
 * Chrome allows exactly one process per profile directory, so a session is
 * not something this app can attempt twice and let the loser fail: the loser
 * fails with a message nobody at a counter can act on. `launching` covers an
 * attempt still being prepared, and `teardown` covers the far longer window
 * where a dead session's `client` has already been cleared but its browser is
 * still on its way out. Everything that starts a session waits on both.
 */
let launching = false
let teardown: Promise<void> | null = null
/** One silent sweep-and-retry per attempt if a launch still finds the profile busy — see handleLaunchFailure. Cleared by any launch that gets as far as a QR or a ready session. */
let lockRetryUsed = false

/**
 * A session can die without ever emitting `disconnected`.
 *
 * whatsapp-web.js talks to WhatsApp Web through a Puppeteer page, and when
 * WhatsApp Web reloads itself — which it does on its own schedule, and does
 * when the account's set of linked devices changes — that page's frame is
 * replaced. The `Client` object survives, its status stays `connected`, and
 * every call through it fails with *"Attempted to use detached Frame"*. That
 * is exactly what happened here: bills silently stopped sending while the
 * badge in the app shell still read Connected, because nothing was checking.
 *
 * So the session is now polled instead of trusted. `getState()` runs inside
 * that page, so it fails the moment the page is gone — the cheapest possible
 * proof that the thing is still alive.
 */
const HEALTH_CHECK_INTERVAL_MS = 30_000
/** Two consecutive bad checks before restarting, so one transient hiccup doesn't bounce a working session. A dead page skips the wait — it never recovers on its own. */
const UNHEALTHY_CHECKS_BEFORE_RESTART = 2
/** A much longer leash for a merely-reconnecting socket (see `classifySocketState`) — but not unlimited, since a socket stuck OPENING forever is still a hang. */
const TRANSIENT_CHECKS_BEFORE_RESTART = 10
let healthTimer: ReturnType<typeof setInterval> | null = null
let unhealthyChecks = 0
let transientChecks = 0

/**
 * Errors that mean the page behind the session is gone rather than that this
 * particular call failed. Matched on message text because Puppeteer raises
 * them as plain `Error`s with no code to switch on.
 */
function isDeadPageError(err: unknown): boolean {
  return /detached frame|session closed|target closed|protocol error|execution context was destroyed|page has been closed|browser has disconnected|websocket is not open/i.test(
    describeError(err),
  )
}

/**
 * Tears the session down and reconnects from scratch. Used when the session
 * is provably broken but hasn't told us so — a `disconnected` event does its
 * own teardown and doesn't come through here.
 */
async function restartWhatsAppClient(reason: string): Promise<void> {
  if (quitting) return
  const current = client
  if (!current) return
  stopReadyPoll()
  trace(`restart: ${reason}`)
  client = null
  unhealthyChecks = 0
  transientChecks = 0
  // A rebuilt session starts unauthenticated, so it must start on the connect
  // budget rather than inheriting the 600s sync leash from the attempt that
  // just failed.
  syncing = false
  clearConnectWatchdog()
  stopQrKeepalive()
  resetQrTracking()
  console.warn(`[whatsapp] restarting the session — ${reason}`)
  setState(nextWhatsAppState({ type: 'disconnected', reason }))
  await beginTeardown(current)
  // Back to the front of the backoff list: this isn't a flaky network, it's a
  // session that needs rebuilding, and it should rebuild promptly rather than
  // inheriting a long delay from some earlier drop.
  reconnectAttempt = 0
  scheduleReconnect()
}

async function checkSessionHealth(): Promise<void> {
  const current = client
  if (quitting || !current || state.status !== 'connected') return

  let failure: string | null = null
  try {
    const socketState = await current.getState()
    const health = classifySocketState(socketState)
    if (health === 'healthy') {
      unhealthyChecks = 0
      transientChecks = 0
      return
    }
    if (health === 'transient') {
      // WhatsApp Web reconnecting itself — leave it alone. This is the common
      // case behind a session that looked broken but wasn't, and tearing it
      // down here is what turned a blip into a multi-minute resync.
      transientChecks += 1
      failure = `WhatsApp Web stayed in "${socketState}" for ${
        (TRANSIENT_CHECKS_BEFORE_RESTART * HEALTH_CHECK_INTERVAL_MS) / 1000
      }s`
    } else {
      failure = `WhatsApp Web reported "${socketState ?? 'no state'}"`
      unhealthyChecks += 1
    }
  } catch (err: unknown) {
    failure = describeError(err)
    // A detached page never heals; waiting out a second check only delays the
    // reconnect while bills fail.
    unhealthyChecks = isDeadPageError(err) ? UNHEALTHY_CHECKS_BEFORE_RESTART : unhealthyChecks + 1
  }

  if (
    unhealthyChecks >= UNHEALTHY_CHECKS_BEFORE_RESTART ||
    transientChecks >= TRANSIENT_CHECKS_BEFORE_RESTART
  ) {
    await restartWhatsAppClient(failure ?? 'the session stopped responding')
  }
}

function startHealthChecks(): void {
  if (healthTimer) return
  healthTimer = setInterval(() => void checkSessionHealth(), HEALTH_CHECK_INTERVAL_MS)
}

/**
 * A connect attempt that never finishes is worse than one that fails.
 *
 * `Client.initialize()` navigates with `timeout: 0` — literally "wait
 * forever" — so anything that stops the page loading leaves the session in
 * `connecting` with no error, no event, and nothing to recover it. The badge
 * reads "Connecting…" indefinitely and every sale's WhatsApp send is refused
 * because the session isn't ready. Reaching `qr` counts as finishing: waiting
 * for a human to scan is not a hang.
 *
 * This is a **silence** timeout, not a deadline. Restoring a session with a
 * backlog of missed messages legitimately takes minutes, and an earlier
 * version of this measured the whole connect instead — so it kept executing a
 * session that was still syncing perfectly well, over and over, and the app
 * could never finish connecting at all. Every sign of progress
 * (`authenticated`, each offline-sync percentage) re-arms it, so what's being
 * timed is a session that has gone quiet.
 *
 * This budget only covers the stretch *before* authentication. From
 * `authenticated` onwards the far larger SYNC_TIMEOUT_MS applies.
 */
const CONNECT_TIMEOUT_MS = 120_000
/**
 * The budget once WhatsApp Web has actually started handing over the offline
 * backlog. Deliberately far larger than the connect budget, because the
 * quietest part of a sync is its *tail*: `loading_screen` only fires when the
 * percentage changes, and after the last one there is a long, silent stretch
 * while the messages are decrypted and written to the local store. Timing that
 * out is the worst of both worlds — it throws away work that was progressing
 * and hands the next attempt an even bigger backlog to deliver, which is
 * exactly the loop that made this look like it could never finish connecting.
 */
const SYNC_TIMEOUT_MS = 600_000
/** True once this attempt has authenticated, so the only work left is the offline backlog — see SYNC_TIMEOUT_MS. */
let syncing = false
/** Cap on how long a teardown may take before Chrome is killed outright. */
const DESTROY_TIMEOUT_MS = 10_000
let connectTimer: ReturnType<typeof setTimeout> | null = null

function clearConnectWatchdog(): void {
  if (!connectTimer) return
  clearTimeout(connectTimer)
  connectTimer = null
}

function armConnectWatchdog(target: InstanceType<typeof Client>): void {
  clearConnectWatchdog()
  const budget = syncing ? SYNC_TIMEOUT_MS : CONNECT_TIMEOUT_MS
  connectTimer = setTimeout(() => {
    connectTimer = null
    // Only act on the attempt this watchdog was armed for, and only if it's
    // still stuck: a newer client, or one that got as far as a QR, is fine.
    if (quitting || client !== target) return
    if (state.status === 'connected' || state.status === 'qr') return
    void restartWhatsAppClient(
      `WhatsApp Web went quiet for ${budget / 1000}s while ${syncing ? 'syncing' : 'connecting'}`,
    )
  }, budget)
}

/**
 * Tears a session down and makes sure its Chrome is actually gone.
 *
 * `Client.destroy()` closes the browser only if its CDP connection still
 * reports as connected, and `browser.close()` itself can hang on a wedged
 * one — so on exactly the broken sessions worth destroying, it can quietly
 * leave Chrome running. That matters more than an idle process: a live Chrome
 * holds the LocalAuth profile directory locked, and the *next* connect
 * attempt then launches against a profile it can never open and hangs
 * forever inside `initialize()`. One dead session became an app permanently
 * stuck on "Connecting…" that way. Killing the process is the only teardown
 * that can be relied on, so it's the fallback rather than the last resort.
 */
async function forceDestroy(target: InstanceType<typeof Client>): Promise<void> {
  const browserProcess = target.pupBrowser?.process() ?? null
  try {
    await withTimeout(target.destroy(), DESTROY_TIMEOUT_MS, 'closing the WhatsApp browser timed out')
  } catch (err: unknown) {
    console.warn('[whatsapp] closing the session cleanly failed; killing its browser:', describeError(err))
  }
  if (browserProcess && browserProcess.exitCode === null && !browserProcess.killed) {
    try {
      browserProcess.kill('SIGKILL')
    } catch (err: unknown) {
      console.error('[whatsapp] could not kill the WhatsApp browser process:', describeError(err))
    }
  }
  // Whatever the handle above reported, what actually has to be free is the
  // directory. Chrome's helper processes hold it too and outlive a killed
  // parent; a launch that failed before `pupBrowser` existed leaves no handle
  // to kill at all; and a killed browser never gets to remove its own lock
  // files. This is the line that makes "the teardown finished" mean "the next
  // launch can have the profile".
  await ensureProfileFree('after closing the previous session')
}

function stopHealthChecks(): void {
  if (!healthTimer) return
  clearInterval(healthTimer)
  healthTimer = null
}

/**
 * Keeps the code on the Connect screen the one WhatsApp is *currently*
 * offering, rather than whichever one it happened to hand over first.
 *
 * whatsapp-web.js publishes QRs by attaching a `change:ref` listener to
 * WhatsApp Web's `Conn` model, **once**, inside `inject()`. WhatsApp Web
 * rotates that ref roughly every 20s, and after a few unscanned rotations it
 * parks the pairing socket in `UNPAIRED_IDLE` — the "Select to reload QR code"
 * screen — and then relaunches it against a *new* `Conn`. The library's
 * listener does not survive that, so it never emits another `qr` event: the
 * screen keeps rendering the last code it was given, that code is long dead,
 * and scanning it does nothing whatsoever. Which is exactly how this looked
 * from the counter — a QR sitting there that the phone simply ignored.
 *
 * whatsapp-web.js does have recovery for this and it is dead twice over. The
 * handler is registered with `page.exposeFunction`, so its body runs in
 * **Node**, where `window` is undefined and the call throws into a swallowed
 * promise; and the API it reaches for, `WAWebCmd.Cmd.refreshQR`, no longer
 * exists on current WhatsApp Web builds — the function lives on
 * `WAWebLaunchSocketUtils` now. Both were confirmed against the running
 * session (build 2.3000.1045980075) rather than inferred.
 *
 * Nothing else recovers it either: `qr` deliberately clears the connect
 * watchdog (waiting for a human is not a hang) and the health poll only runs
 * once `connected`. So a stale QR was a permanent dead end, and the only way
 * out was to notice and restart the agent by hand.
 *
 * The QR is therefore driven from here while the session waits to be scanned:
 * read the live ref straight out of the page, rebuild the payload byte for
 * byte the way the library does, and republish whenever it changes. A socket
 * found idling is woken first, through the module that still has the function.
 */
const QR_KEEPALIVE_INTERVAL_MS = 5_000
/** Consecutive keepalive failures tolerated before the page is treated as gone. A dead page skips the wait, same as the health poll. */
const QR_FAILURES_BEFORE_RESTART = 3
/**
 * How long one code may sit unchanged before the session is rebuilt outright.
 * WhatsApp rotates roughly every 20s, so this is many missed rotations rather
 * than a tight leash — it only fires when waking the socket has stopped
 * working too. Nothing is linked yet at this point, so a rebuild costs a
 * fresh browser page and nothing else.
 */
const QR_STALE_RESTART_MS = 240_000
let qrTimer: ReturnType<typeof setInterval> | null = null
let qrFailures = 0
/** The raw payload last published, so an unrotated ref doesn't re-encode a PNG every five seconds. */
let lastQrPayload: string | null = null
let qrPayloadChangedAt = 0

/**
 * The WhatsApp Web internals the keepalive reaches for. Same caveat as
 * `PageScope` further down: WhatsApp renames these without warning, so every
 * lookup is optional and a miss degrades to "no fresh QR this tick" rather
 * than throwing.
 */
interface QrPageModule {
  Socket?: { state?: string }
  refreshQR?: () => void
  getADVSecretKey?: () => string
}

interface QrPageScope {
  AuthStore?: {
    Conn?: { ref?: string }
    Base64Tools?: { encodeB64: (bytes: unknown) => string }
    RegistrationUtils?: {
      waSignalStore?: { getRegistrationInfo: () => Promise<{ identityKeyPair: { pubKey: unknown } }> }
      waNoiseInfo?: { get: () => Promise<{ staticKeyPair: { pubKey: unknown } }> }
      DEVICE_PLATFORM?: string
    }
  }
  require?: (moduleName: string) => QrPageModule | null
}

function resetQrTracking(): void {
  qrFailures = 0
  lastQrPayload = null
  qrPayloadChangedAt = 0
}

/** Records a payload the library itself published, so the keepalive treats it as current rather than immediately reissuing it. */
function noteQrPayload(payload: string): void {
  lastQrPayload = payload
  qrPayloadChangedAt = Date.now()
}

async function refreshQrCode(target: InstanceType<typeof Client>): Promise<void> {
  if (quitting || client !== target || state.status !== 'qr') return
  const page = target.pupPage
  if (!page) return

  let payload: string | null = null
  try {
    payload = await page.evaluate(async () => {
      // `globalThis` rather than `window`: this runs in the page but is
      // type-checked here in Node, which has no DOM lib — same reasoning as
      // `findRecentOutgoingMessage` below.
      const scope = globalThis as unknown as QrPageScope
      const loadModule = (moduleName: string): QrPageModule | null => {
        try {
          return scope.require ? scope.require(moduleName) : null
        } catch {
          return null
        }
      }

      // A socket that has stopped rotating sits on "Select to reload QR code"
      // and will never produce another ref on its own.
      if (loadModule('WAWebSocketModel')?.Socket?.state === 'UNPAIRED_IDLE') {
        loadModule('WAWebLaunchSocketUtils')?.refreshQR?.()
      }

      const auth = scope.AuthStore
      const registration = auth?.RegistrationUtils
      const ref = auth?.Conn?.ref
      const advSecretKey = loadModule('WAWebUserPrefsMultiDevice')?.getADVSecretKey?.()
      if (!ref || !advSecretKey || !auth?.Base64Tools || !registration?.waSignalStore || !registration.waNoiseInfo) {
        return null
      }

      const info = await registration.waSignalStore.getRegistrationInfo()
      const noise = await registration.waNoiseInfo.get()
      return [
        ref,
        auth.Base64Tools.encodeB64(noise.staticKeyPair.pubKey),
        auth.Base64Tools.encodeB64(info.identityKeyPair.pubKey),
        advSecretKey,
        registration.DEVICE_PLATFORM,
      ].join(',')
    })
    qrFailures = 0
  } catch (err: unknown) {
    // Deliberately *not* short-circuiting on `isDeadPageError` the way the
    // health poll does. WhatsApp Web reloads itself while sitting on the QR
    // screen, and whatsapp-web.js re-injects on `framenavigated`, so an
    // evaluate that races one of those raises "execution context was
    // destroyed" — indistinguishable from a genuinely dead page by message
    // text, and self-healing within a tick or two. Three consecutive misses
    // is only 15s, and a page that really is gone fails all three.
    qrFailures += 1
    if (qrFailures >= QR_FAILURES_BEFORE_RESTART) {
      await restartWhatsAppClient(`the QR code stopped refreshing — ${describeError(err)}`)
    }
    return
  }

  if (payload && payload !== lastQrPayload) {
    noteQrPayload(payload)
    const qrDataUrl = await QRCode.toDataURL(payload)
    // Re-checked after the encode: the code may have been scanned, or the
    // session replaced, while the PNG was being generated.
    if (quitting || client !== target || state.status !== 'qr') return
    setState(nextWhatsAppState({ type: 'qr', qrDataUrl }))
    return
  }

  // Reaching here means the page answered but is still offering the same dead
  // code — waking the socket didn't take, so rebuild the session instead of
  // leaving an unscannable QR on screen indefinitely.
  if (qrPayloadChangedAt && Date.now() - qrPayloadChangedAt > QR_STALE_RESTART_MS) {
    await restartWhatsAppClient(
      `the QR code stopped refreshing for ${QR_STALE_RESTART_MS / 1000}s`,
    )
  }
}

function startQrKeepalive(target: InstanceType<typeof Client>): void {
  stopQrKeepalive()
  qrTimer = setInterval(() => void refreshQrCode(target), QR_KEEPALIVE_INTERVAL_MS)
}

function stopQrKeepalive(): void {
  if (!qrTimer) return
  clearInterval(qrTimer)
  qrTimer = null
}

function scheduleReconnect(): void {
  if (quitting || reconnectTimer) return
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)]
  reconnectAttempt += 1
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    startWhatsAppClient()
  }, delay)
}

/**
 * Runs a teardown and publishes it, so anything that wants to start a session
 * can wait for the old browser to be gone instead of racing it. `client` is
 * cleared the moment a session is written off — up to ten seconds before that
 * session's Chrome has actually exited — and this is the handle on that gap.
 *
 * Waiting on the teardown a *caller* started was never the hard part; the hard
 * part is that the caller is often not the one that starts the next session.
 * A failure hands off to a 2s reconnect timer, and the Owner's "Retry now"
 * button doesn't hand off from anything at all. Both end up in
 * `launchWhatsAppClient`, which is why this is a module-level promise rather
 * than something threaded through the failure handlers.
 */
function beginTeardown(target: InstanceType<typeof Client>): Promise<void> {
  const pending = forceDestroy(target).finally(() => {
    if (teardown === pending) teardown = null
  })
  teardown = pending
  return pending
}

/**
 * Tears a dead session down and only *then* schedules the next attempt.
 *
 * The three failure handlers below used to fire `void forceDestroy(...)` and
 * call `scheduleReconnect()` on the next line, which starts a 2s timer against
 * a teardown that has up to 10s of budget before it resorts to killing Chrome.
 * Chrome allows one process per `--user-data-dir`, so the relaunch lands on a
 * profile the dying browser still holds and fails with *"The browser is
 * already running for …wwebjs_auth\session"*. That was first seen once during
 * a verification run, written off as a wasted reconnect — and then it reached
 * the shop, in a red box, on the Connect screen. Ordering the teardown ahead
 * of the reconnect is only half of the answer; the other half is that nothing
 * anywhere can start a session without going through `beginTeardown`'s promise
 * and `ensureProfileFree` first.
 */
function tearDownThenReconnect(target: InstanceType<typeof Client>): void {
  void beginTeardown(target).finally(() => scheduleReconnect())
}

function setState(next: WhatsAppState): void {
  state = next
  if (next.status === 'connected') reconnectAttempt = 0
  for (const listener of listeners) listener(state)
}

export function getWhatsAppState(): WhatsAppState {
  return state
}

/** Returns an unsubscribe function. Used by main.ts to forward every change to the renderer. */
export function onWhatsAppStateChange(listener: (state: WhatsAppState) => void): () => void {
  listeners.push(listener)
  return () => {
    listeners = listeners.filter((l) => l !== listener)
  }
}

/**
 * Fires on every real WhatsApp delivery/read update for a message this app
 * sent (whatsapp-web.js's 'message_ack' event) — the data source for the
 * Owner-only bill-delivery ticks. Returns an unsubscribe function, same
 * pattern as `onWhatsAppStateChange`.
 */
export function onWhatsAppMessageAck(listener: (waMessageId: string, ack: number) => void): () => void {
  ackListeners.push(listener)
  return () => {
    ackListeners = ackListeners.filter((l) => l !== listener)
  }
}

function authDataPath(): string {
  // Persisted under Electron's userData dir (same base as db.ts's app.db) so
  // the session — and this LocalAuth's saved cookies/keys — survive an app
  // restart without re-scanning, per PHASE6.md acceptance criterion 1.
  return path.join(app.getPath('userData'), 'wwebjs_auth')
}

/**
 * The directory Chrome is actually launched against.
 *
 * `LocalAuth` appends `session` to its `dataPath` and hands *that* to Puppeteer
 * as `--user-data-dir`, so this — not `authDataPath()` — is the directory
 * Chrome locks, and the one every complaint about a busy profile names.
 */
function profileDir(): string {
  return path.join(authDataPath(), 'session')
}

/**
 * Chrome's own singleton markers, left behind by any exit that wasn't clean —
 * which, on this app's teardown path, means every time a wedged browser had to
 * be killed.
 *
 * They matter more than stray files because of how Puppeteer reports a failed
 * launch on Windows: it can't read Chrome's logs through the singleton
 * handover, so it treats the presence of `lockfile` as proof that a browser is
 * already running and rewrites **any** launch failure into *"The browser is
 * already running for …\wwebjs_auth\session"* (puppeteer-core's
 * `BrowserLauncher.js`). A leftover therefore both looks like the problem and
 * hides the real one. Cleared before every launch — but only once nothing is
 * holding the profile, since a live Chrome's lock is doing its job.
 */
const CHROME_LOCK_FILES = ['lockfile', 'SingletonLock', 'SingletonCookie', 'SingletonSocket']

/**
 * How long to keep killing and re-checking before giving up on freeing the
 * profile. Killing Chrome's parent process does not take its renderer, GPU and
 * utility children with it, and they hold the profile directory too — so what
 * is being waited out here is the gap between "killed" and "gone", which is the
 * gap the old teardown relaunched into.
 */
const PROFILE_RELEASE_TIMEOUT_MS = 10_000

function runPowerShell(script: string, timeoutMs: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err instanceof Error ? err : new Error(String(err)))
        else resolve(stdout)
      },
    )
  })
}

/**
 * Kills every Chrome holding this app's WhatsApp profile and waits for them to
 * actually be gone, returning how many survived. `null` means the check itself
 * could not run, which is not the same as "none left" and is never treated as
 * such.
 *
 * The match is on this profile's path appearing in the command line — Chrome
 * passes `--user-data-dir` to its child processes too, so one pass catches the
 * whole tree — which is also why this can never touch a Chrome window belonging
 * to whoever is at the counter. `.Contains()` rather than `-like`, so nothing
 * in the path can be read as a wildcard.
 */
async function killChromeHoldingProfile(): Promise<number | null> {
  if (process.platform !== 'win32') return 0

  // Single-quoted PowerShell string: the only character needing escaping is
  // the quote itself.
  const dir = profileDir().replace(/'/g, "''")
  const script = [
    `$dir = '${dir}'`,
    `$deadline = (Get-Date).AddMilliseconds(${PROFILE_RELEASE_TIMEOUT_MS})`,
    'function Get-Holders {',
    `  @(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" |`,
    '    Where-Object { $_.CommandLine -and $_.CommandLine.Contains($dir) })',
    '}',
    // Every call is re-wrapped in `@()` at the call site. PowerShell unrolls an
    // empty array on the way out of a function, so `Get-Holders` returning
    // nothing assigns `$null` — and the count of that reaches Node as an empty
    // line, which is indistinguishable from the check having failed. Caught by
    // running this against a throwaway profile: it killed all eight processes
    // and then reported nothing, so the lock files would never have been
    // cleared.
    '$holders = @(Get-Holders)',
    'while ($holders.Count -gt 0 -and (Get-Date) -lt $deadline) {',
    '  foreach ($p in $holders) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }',
    '  Start-Sleep -Milliseconds 200',
    '  $holders = @(Get-Holders)',
    '}',
    'Write-Output $holders.Count',
  ].join('\n')

  try {
    const stdout = await runPowerShell(script, PROFILE_RELEASE_TIMEOUT_MS + 5_000)
    const survivors = Number.parseInt(stdout.trim(), 10)
    return Number.isFinite(survivors) ? survivors : null
  } catch (err: unknown) {
    console.warn('[whatsapp] could not check what is holding the session profile:', describeError(err))
    return null
  }
}

function clearChromeLockFiles(): void {
  for (const name of CHROME_LOCK_FILES) {
    try {
      fs.rmSync(path.join(profileDir(), name), { force: true })
    } catch (err: unknown) {
      // A lock file that can't be removed is worth knowing about but not worth
      // refusing to connect over — the launch that follows may well be fine.
      console.warn(`[whatsapp] could not remove a stale ${name}:`, describeError(err))
    }
  }
}

/**
 * Guarantees nothing owns the WhatsApp profile directory. Every Chrome launch
 * in this file goes through it, and so does the end of every teardown.
 *
 * Chrome allows exactly one process per `--user-data-dir`, and a second launch
 * against a held profile does not queue or fail cleanly: on Windows it hands
 * off to the running browser and exits, Puppeteer's connection never comes up,
 * and the attempt dies as *"The browser is already running for
 * …\wwebjs_auth\session. Use a different `userDataDir` or stop the running
 * browser first."* — a message written for whoever wrote the code, shown in a
 * red box, on a shop counter, to someone who cannot act on it.
 *
 * Every route to that message ends here:
 *   - a browser this app killed whose helper processes outlived their parent,
 *   - a browser from a launch that failed before `pupBrowser` existed, so there
 *     was never a handle to kill it with,
 *   - a browser orphaned by a crash, a hard kill, or a dev-server restart,
 *     none of which get to run a teardown at all,
 *   - and the stale lock files every one of those leaves behind.
 *
 * It is only ever called when this process has no live session of its own — 
 * before a launch, and after a teardown — so it can never kill the browser the
 * app is currently using.
 */
async function ensureProfileFree(reason: string): Promise<void> {
  if (process.platform !== 'win32') return

  const survivors = await killChromeHoldingProfile()
  if (survivors === null) return
  if (survivors > 0) {
    // Worth saying out loud: the launch that follows is the one that will fail,
    // and this line is the reason why.
    console.warn(
      `[whatsapp] ${survivors} browser process(es) still hold the session profile (${reason})`,
    )
    return
  }
  clearChromeLockFiles()
}

/**
 * The agent's startup sweep, under the name it has always had (see
 * `agent/server.ts`). It now shares one implementation with the check every
 * launch does anyway — a browser left behind by a previous run is the same
 * problem as one left behind by the previous attempt, and there is no reason
 * for the app to have two answers to it.
 */
export function releaseStaleWhatsAppBrowsers(): Promise<void> {
  return ensureProfileFree('left behind by a previous run')
}

/**
 * Idempotent — safe to call at every app launch, from the reconnect backoff,
 * and from the Owner's "Retry now" button, at any moment, in any state.
 *
 * That last part is the whole point, and it used to be untrue. Three rules
 * make it true: a launch already in flight wins, a session that already has a
 * browser is never launched over, and a session still being torn down is
 * waited for. Only one Chrome can exist per profile, so "start another one and
 * see what happens" is never an option here — see `ensureProfileFree`.
 *
 * If a persisted LocalAuth session exists on disk, whatsapp-web.js restores it
 * silently — status goes straight to 'connecting' then 'connected', no 'qr'
 * event fires. If not, it emits 'qr' and the Owner-only Connect screen renders
 * the code for a first-time scan.
 */
export function startWhatsAppClient(): void {
  void launchWhatsAppClient()
}

async function launchWhatsAppClient(): Promise<void> {
  // The rule itself lives in state.ts, pure and tested — including the case
  // this used to get wrong, where a 'qr' session is a live browser and the
  // Connect screen's "Retry now" button was enough to launch a second one
  // against the same profile. It does not cover the seconds between a failure
  // being published and its teardown finishing, when `client` is already null
  // but Chrome is not yet gone; that is what awaiting `teardown` below is for.
  if (!canStartSession({ quitting, launching, hasClient: client !== null, status: state.status })) return

  launching = true
  try {
    setState(nextWhatsAppState({ type: 'connecting' }))
    syncing = false
    resetQrTracking()

    // A teardown in flight still owns the profile. It clears `client` the
    // moment a session is written off, which is up to ten seconds before that
    // session's Chrome has actually exited.
    if (teardown) await teardown.catch(() => {})
    if (quitting || client) return

    // The precondition every launch in this file depends on: nothing else is
    // holding the profile directory this Chrome is about to open.
    await ensureProfileFree('before connecting')
    if (quitting || client) return

    const nextClient = new Client({
      authStrategy: new LocalAuth({ dataPath: authDataPath() }),
      puppeteer: {
        headless: true,
        // Uses the machine's installed Chrome instead of Puppeteer's own managed
        // download — that download's extraction was unreliably dropping chrome.exe
        // on this machine even with antivirus exclusions in place.
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      },
    })
    client = nextClient
    trace('launch: client created, initializing')

    nextClient.on('qr', (qr) => {
      clearConnectWatchdog()
      // A browser that got as far as offering a QR launched cleanly, so the
      // one-shot profile-lock retry is available again for the next attempt.
      lockRetryUsed = false
      // Recorded before the encode so the keepalive treats this code as the
      // current one and doesn't immediately reissue an identical PNG.
      noteQrPayload(qr)
      QRCode.toDataURL(qr)
        .then((qrDataUrl) => setState(nextWhatsAppState({ type: 'qr', qrDataUrl })))
        .catch((err: unknown) =>
          setState(nextWhatsAppState({ type: 'auth_failure', message: describeError(err) })),
        )
    })

    nextClient.on('authenticated', () => {
      trace('authenticated')
      // Auth is the point the budget has to change, not the first
      // `loading_screen`: once credentials are accepted the only work left is
      // the offline backlog, and WhatsApp Web routinely says nothing at all
      // between here and its first percentage — comfortably longer than
      // CONNECT_TIMEOUT_MS on a busy number. Flipping this on the percentage
      // instead meant the watchdog executed sessions that were syncing
      // perfectly well, and handed each retry a larger backlog to deliver
      // inside the same 120s: a loop that could never converge.
      syncing = true
      armConnectWatchdog(nextClient)
      setState(nextWhatsAppState({ type: 'authenticated' }))
    })

    // Progress through WhatsApp Web's offline sync. Both a sign of life for the
    // watchdog above and, on a session with a real backlog, the difference
    // between a screen that looks stuck and one that's visibly working.
    nextClient.on('loading_screen', (percent: number | string) => {
      trace(`loading_screen ${percent}`)
      armConnectWatchdog(nextClient)
      const parsed = Number(percent)
      setState(nextWhatsAppState({ type: 'loading', percent: Number.isFinite(parsed) ? parsed : 0 }))
      if (parsed >= 100 && readyPoll === null) {
        readyPoll = setInterval(async () => {
          try {
            const s = await nextClient.getState()
            trace(`poll getState = ${s}`)
          } catch (e: unknown) {
            trace(`poll getState failed: ${describeError(e)}`)
          }
        }, 5000)
      }
    })

    nextClient.on('ready', () => {
      stopReadyPoll()
      trace('ready')
      const number = nextClient.info?.wid?.user ?? 'unknown'
      unhealthyChecks = 0
      transientChecks = 0
      syncing = false
      lockRetryUsed = false
      clearConnectWatchdog()
      // Linked — there is no QR left to keep alive, and the health poll takes
      // over from here.
      stopQrKeepalive()
      resetQrTracking()
      setState(nextWhatsAppState({ type: 'ready', number }))
    })

    nextClient.on('message_ack', (message: Message, ack: number) => {
      for (const listener of ackListeners) listener(message.id._serialized, ack)
    })

    nextClient.on('auth_failure', (message: string) => {
      stopReadyPoll()
      trace(`auth_failure: ${message}`)
      clearConnectWatchdog()
      setState(nextWhatsAppState({ type: 'auth_failure', message }))
      if (client === nextClient) client = null
      tearDownThenReconnect(nextClient)
    })

    nextClient.on('disconnected', (reason) => {
      stopReadyPoll()
      trace(`disconnected: ${String(reason)}`)
      clearConnectWatchdog()
      setState(nextWhatsAppState({ type: 'disconnected', reason: String(reason) }))
      if (client === nextClient) client = null
      tearDownThenReconnect(nextClient)
    })

    startHealthChecks()
    startQrKeepalive(nextClient)
    armConnectWatchdog(nextClient)

    nextClient.initialize().catch((err: unknown) => handleLaunchFailure(nextClient, err))
  } catch (err: unknown) {
    // Only the preparation above can land here — building the client, or the
    // profile sweep failing outright. There is no session to tear down in
    // either case, so this reports and re-queues rather than going through
    // `forceDestroy`.
    console.error('[whatsapp] could not start a session:', describeError(err))
    setState(nextWhatsAppState({ type: 'auth_failure', message: describeError(err) }))
    scheduleReconnect()
  } finally {
    launching = false
  }
}

/**
 * A launch that never got off the ground.
 *
 * One failure is worth handling on its own: a profile that was still in use.
 * It isn't an authentication problem, it isn't the Owner's to fix, and the
 * text Puppeteer produces for it — *"Use a different `userDataDir` or stop the
 * running browser first"* — is an instruction to a programmer, shown in a red
 * box to whoever is standing at the counter. `ensureProfileFree` runs before
 * every launch precisely so this cannot arise; if it arises anyway, the answer
 * is to clear the profile properly and try again, not to announce it. Only a
 * second consecutive one is surfaced, and then in words that say what the app
 * is doing about it.
 */
function handleLaunchFailure(target: InstanceType<typeof Client>, err: unknown): void {
  stopReadyPoll()
  clearConnectWatchdog()
  stopQrKeepalive()
  if (client === target) client = null

  if (isProfileLockedError(err) && !lockRetryUsed) {
    lockRetryUsed = true
    console.warn('[whatsapp] the session profile was still in use — clearing it and retrying:', describeError(err))
    // Deliberately not an `auth_failure`: nothing failed to authenticate, and
    // the badge should read as a session on its way back rather than a broken
    // one. `forceDestroy` ends in a profile sweep, so the retry two seconds
    // later lands on a directory nothing is holding.
    setState(nextWhatsAppState({ type: 'disconnected', reason: 'Finishing the previous WhatsApp session…' }))
    reconnectAttempt = 0
    void beginTeardown(target).finally(() => scheduleReconnect())
    return
  }

  setState(nextWhatsAppState({ type: 'auth_failure', message: describeLaunchFailure(err) }))
  tearDownThenReconnect(target)
}

/** `isProfileLockedMessage` (pure, in state.ts, and tested there) against whatever this error turned out to be. */
function isProfileLockedError(err: unknown): boolean {
  return isProfileLockedMessage(describeError(err))
}

/** The profile-lock wording, rewritten for the person who has to read it. Every other failure keeps its own text, which is what the logs and `whatsapp_log.error` are diagnosed from. */
function describeLaunchFailure(err: unknown): string {
  if (!isProfileLockedError(err)) return describeError(err)
  return 'The previous WhatsApp session was still shutting down.'
}

/**
 * Owner-only management action (gated by assertPermission at the IPC layer
 * in main.ts, per PHASE6.md section 5's `whatsapp:manage_session`). Clears
 * the persisted session so the phone can be unlinked and a different one
 * scanned in, then immediately starts a fresh connect attempt so the Connect
 * screen has a new QR to show right away.
 */
export async function logoutWhatsAppSession(): Promise<void> {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  reconnectAttempt = 0
  clearConnectWatchdog()
  const current = client
  client = null
  if (current) {
    await current.logout().catch(() => {})
    await beginTeardown(current)
  }
  setState(nextWhatsAppState({ type: 'logged_out' }))
  startWhatsAppClient()
}

/** Called on app quit so Puppeteer's Chromium process doesn't linger after the Electron window closes. */
export async function stopWhatsAppClient(): Promise<void> {
  quitting = true
  stopHealthChecks()
  stopQrKeepalive()
  clearConnectWatchdog()
  stopReadyPoll()
  if (reconnectTimer) {
    clearTimeout(reconnectTimer)
    reconnectTimer = null
  }
  const current = client
  client = null
  if (current) await beginTeardown(current)
}

/** Thrown by `sendWhatsAppMessage` on any failure — disconnected session, unregistered number, or a whatsapp-web.js send error — so callers can distinguish a send failure from a successful send. */
export class WhatsAppSendError extends Error {}

/**
 * A confirmed-sent message. `waMessageId` is whatsapp-web.js's own
 * `Message.id._serialized`, used to match later `message_ack` delivery/read
 * events back to the log row — but it is **nullable**, because WhatsApp Web
 * does not always hand back a usable handle for a message it genuinely sent
 * (see `sendWhatsAppMessage` below). A null id means "delivered, but we
 * can't track its ticks", never "not delivered".
 */
export interface WhatsAppSendResult {
  waMessageId: string | null
  ack: number | null
}

/** Shape of the raw WhatsApp Web message models we read in `findRecentOutgoingMessage`'s page context. */
interface RawPageMessage {
  id?: { _serialized?: string; fromMe?: boolean; remote?: { _serialized?: string } }
  to?: { _serialized?: string }
  t?: number
  ack?: number
  type?: string
  body?: string
  caption?: string
}

interface RawCollection {
  getModelsArray?: () => RawPageMessage[]
}

interface RawChat {
  msgs?: RawCollection
}

interface RawModule {
  Chat?: { get?: (wid: unknown) => RawChat | null }
  Msg?: RawCollection
  createWid?: (chatId: string) => unknown
}

/** The handful of WhatsApp Web globals `findRecentOutgoingMessage` reaches for, any of which may be absent on a given WhatsApp Web build. */
interface PageScope {
  WWebJS?: { getChat?: (chatId: string, options: { getAsModel: boolean }) => Promise<RawChat | null> }
  require?: (moduleName: string) => RawModule | null
  Store?: { Msg?: RawCollection }
}

/** A verification hit: the message found sitting in the chat, plus which lookup found it (logged only — never shown to the Owner). */
interface VerifiedMessage extends WhatsAppSendResult {
  via: string
}

/**
 * How long to wait on WhatsApp Web for one bill send, and for the "is this
 * number on WhatsApp" lookup that precedes it. These exist because the send
 * now asks WhatsApp Web to wait for its own send result (see
 * `sendWhatsAppMessage`), which never resolves at all if the linked phone
 * goes silent — and `sale:create` awaits this whole thing with someone
 * standing at the counter. Both recipients are sent to concurrently, so the
 * worst case for a sale is one of these, not their sum.
 */
const SEND_TIMEOUT_MS = 25_000
const NUMBER_LOOKUP_TIMEOUT_MS = 15_000

/** One immediate look plus two short retries — the model is normally in the collection already; the retries only cover a slow re-key. */
const VERIFY_RETRY_DELAYS_MS = [0, 400, 900]

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Rejects with a `WhatsAppSendError` carrying `message` if `promise` hasn't
 * settled in time. The underlying work isn't cancellable — this only stops
 * *us* waiting on it, which is the part that matters when a sale is blocked
 * on the result.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new WhatsAppSendError(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      },
    )
  })
}

/**
 * Looks for a message this app just sent sitting in the chat, used to settle
 * the ambiguous outcomes of `Client.sendMessage` (see `sendWhatsAppMessage`).
 *
 * Deliberately reads only primitive fields straight off WhatsApp Web's own
 * message models rather than going through `Chat.fetchMessages()` — that
 * helper maps every message through `WWebJS.getMessageModel()`, whose
 * `message.serialize()` call is exactly the fragile step this function
 * exists to work around.
 *
 * Four independent lookups are tried in turn because each one reaches into
 * WhatsApp Web's internals by module name, and WhatsApp renames those
 * without warning — a rename used to take the *only* strategy with it and
 * turn every send into an unverifiable one. Any single lookup succeeding is
 * enough; null means none of them found anything.
 */
async function findRecentOutgoingMessage(
  current: InstanceType<typeof Client>,
  chatId: string,
  caption: string | null,
  sinceUnixSec: number,
): Promise<VerifiedMessage | null> {
  const page = current.pupPage
  if (!page) return null

  for (const wait of VERIFY_RETRY_DELAYS_MS) {
    if (wait > 0) await delay(wait)
    try {
      const found = (await page.evaluate(
        async (chatIdArg: string, captionArg: string | null, sinceArg: number) => {
          // `globalThis` rather than `window`: this callback is serialised
          // and run in the page, but type-checked here in the main process's
          // Node context, which has no DOM lib.
          const scope = globalThis as unknown as PageScope

          const loadModule = (moduleName: string): RawModule | null => {
            try {
              return scope.require ? scope.require(moduleName) : null
            } catch {
              return null
            }
          }

          const isOurs = (message: RawPageMessage): boolean => {
            if (message.id?.fromMe !== true) return false
            // Only a message created since this attempt started (5s of slack
            // for clock skew) can be the one we just sent.
            if (typeof message.t === 'number' && message.t < sinceArg - 5) return false
            if (!captionArg) return true
            const text =
              typeof message.caption === 'string'
                ? message.caption
                : typeof message.body === 'string'
                  ? message.body
                  : ''
            if (text === captionArg || text.includes(captionArg)) return true
            // A media message whose caption we can't read off the raw model
            // still counts: outgoing, inside this attempt's few-second
            // window, is already a near-certain match, and insisting on an
            // exact caption is one of the things that produced false "Not
            // delivered" rows.
            return typeof message.type === 'string' && message.type !== 'chat'
          }

          const belongsToThisChat = (message: RawPageMessage): boolean =>
            message.id?.remote?._serialized === chatIdArg || message.to?._serialized === chatIdArg

          /**
           * `fromMixedCollection` distinguishes one chat's own message list
           * (in order, so the scan can stop once it is clearly past this
           * send) from the app-wide message collection (every chat
           * interleaved, so it must be filtered by chat and read to the end).
           */
          const scan = (
            models: RawPageMessage[] | null | undefined,
            fromMixedCollection: boolean,
          ): WhatsAppSendResult | null => {
            if (!models) return null
            for (let i = models.length - 1; i >= 0; i -= 1) {
              const message = models[i]
              if (!message) continue
              if (fromMixedCollection) {
                if (!belongsToThisChat(message)) continue
              } else if (typeof message.t === 'number' && message.t < sinceArg - 60) {
                break
              }
              if (!isOurs(message)) continue
              let waMessageId: string | null = null
              try {
                waMessageId = typeof message.id?._serialized === 'string' ? message.id._serialized : null
              } catch {
                waMessageId = null
              }
              return { waMessageId, ack: typeof message.ack === 'number' ? message.ack : null }
            }
            return null
          }

          // 1. whatsapp-web.js's own chat lookup — the happy path.
          try {
            const chat = scope.WWebJS?.getChat ? await scope.WWebJS.getChat(chatIdArg, { getAsModel: false }) : null
            const hit = scan(chat?.msgs?.getModelsArray?.(), false)
            if (hit) return { ...hit, via: 'WWebJS.getChat' }
          } catch {
            /* unavailable on this WhatsApp Web build — try the next lookup */
          }

          // 2. The chat collection directly, in case WWebJS itself never loaded.
          try {
            const collections = loadModule('WAWebCollections')
            const widFactory = loadModule('WAWebWidFactory')
            const wid = widFactory?.createWid ? widFactory.createWid(chatIdArg) : chatIdArg
            const chat = collections?.Chat?.get ? collections.Chat.get(wid) : null
            const hit = scan(chat?.msgs?.getModelsArray?.(), false)
            if (hit) return { ...hit, via: 'WAWebCollections.Chat' }
          } catch {
            /* unavailable on this WhatsApp Web build — try the next lookup */
          }

          // 3. The app-wide message collection, filtered down to this chat —
          //    survives the chat itself being re-keyed (LID vs phone number).
          try {
            const collections = loadModule('WAWebCollections')
            const hit = scan(collections?.Msg?.getModelsArray?.(), true)
            if (hit) return { ...hit, via: 'WAWebCollections.Msg' }
          } catch {
            /* unavailable on this WhatsApp Web build — try the next lookup */
          }

          // 4. Older WhatsApp Web builds exposed that same collection here.
          try {
            const hit = scan(scope.Store?.Msg?.getModelsArray?.(), true)
            if (hit) return { ...hit, via: 'Store.Msg' }
          } catch {
            /* unavailable on this WhatsApp Web build */
          }

          return null
        },
        chatId,
        caption,
        sinceUnixSec,
      )) as VerifiedMessage | null

      if (found) return found
    } catch (err: unknown) {
      console.error('[whatsapp] could not look inside the chat to verify the send:', err)
      return null
    }
  }
  return null
}

/**
 * Sends a message (plain text, or a MessageMedia image with an optional
 * caption — the bill image + short caption built in src/lib/billImage.ts) to
 * `number` (digits only, country code first, no leading '+' — e.g.
 * '919876543210'; whatsapp-web.js's own chat-id form). Used by
 * electron/whatsapp/send.ts right after a sale is created (PHASE6.md
 * section 3). Always throws `WhatsAppSendError` rather than resolving on
 * failure, so a caller that forgets to check a boolean can't accidentally
 * treat a failed send as successful.
 *
 * The hard part isn't sending — it's deciding afterwards whether it went.
 * `Client.sendMessage` has three outcomes and only one of them is
 * unambiguous:
 *
 *   - Resolves with a Message. Sent, and we have its id for delivery ticks.
 *   - Resolves with `undefined`. **Also sent.** Internally it awaits the real
 *     send and only then calls `Msg.get(newMsgKey._serialized)` to hand the
 *     model back; that lookup misses whenever WhatsApp re-keys the message
 *     (LID vs phone-number addressing), which is routine for media. Nothing
 *     about the send failed — we just weren't handed a handle.
 *   - Throws. Still no proof the message wasn't sent: the throw usually comes
 *     from `WWebJS.getMessageModel(msg).serialize()`, which runs *after* the
 *     send. This is the one case worth going and looking in the chat for.
 *
 * Treating that middle case as a failure is what put "Not delivered" under
 * bills the customer was already holding — and, because the Phase 7 print
 * gate keys off the same flag, locked the printer at the counter as well.
 * A missing message id is a missing *tick*, never a missing message.
 */
export async function sendWhatsAppMessage(
  number: string,
  content: string | MessageMedia,
  options?: { caption?: string },
): Promise<WhatsAppSendResult> {
  const current = client
  if (state.status !== 'connected' || !current) {
    throw new WhatsAppSendError('WhatsApp is not connected — reconnect, then send this bill again.')
  }

  let numberId: Awaited<ReturnType<typeof current.getNumberId>>
  try {
    numberId = await withTimeout(
      current.getNumberId(number),
      NUMBER_LOOKUP_TIMEOUT_MS,
      `WhatsApp took too long to confirm whether +${number} is registered.`,
    )
  } catch (err: unknown) {
    throw new WhatsAppSendError(describeSendFailure(err))
  }
  if (!numberId) {
    throw new WhatsAppSendError(`+${number} is not on WhatsApp — check the number.`)
  }

  const chatId = numberId._serialized
  const caption = options?.caption ?? null
  const startedAtUnix = Math.floor(Date.now() / 1000)

  // `waitUntilMsgSent` makes the injected sender await WhatsApp Web's *own*
  // send-result promise instead of returning as soon as the message has been
  // queued locally, so a clean resolve here means WhatsApp accepted the
  // message rather than merely writing it into the chat. It's an option
  // `Client.sendMessage` passes straight through but doesn't declare, hence
  // the cast. The timeout above is what keeps that stronger guarantee from
  // becoming an unbounded wait when the linked phone goes quiet.
  const sendOptions = { ...options, waitUntilMsgSent: true } as Parameters<typeof current.sendMessage>[2]

  // whatsapp-web.js 1.34.7's own bundled types declare this as
  // `Promise<Message>`, but Client.sendMessage actually resolves
  // `Message | undefined` — the cast keeps that honest here so the checks
  // below can't be optimised away as "impossible".
  let sent: Message | undefined
  try {
    sent = (await withTimeout(
      current.sendMessage(chatId, content, sendOptions),
      SEND_TIMEOUT_MS,
      'WhatsApp did not finish sending in time.',
    )) as Message | undefined
  } catch (err: unknown) {
    const verified = await findRecentOutgoingMessage(current, chatId, caption, startedAtUnix)
    if (verified) {
      console.warn(
        `[whatsapp] sendMessage to ${number} threw after the message was already in the chat (found via ${verified.via}) — treating as sent:`,
        describeError(err),
      )
      return { waMessageId: verified.waMessageId, ack: verified.ack }
    }
    throw new WhatsAppSendError(describeSendFailure(err))
  }

  if (sent?.id?._serialized) {
    return { waMessageId: sent.id._serialized, ack: sent.ack ?? 0 }
  }

  // Sent, but handed back no usable handle (the routine media case above).
  // This lookup is only about recovering the message id so delivery ticks can
  // follow it; not finding it downgrades the ticks, never the send.
  const verified = await findRecentOutgoingMessage(current, chatId, caption, startedAtUnix)
  if (verified) return { waMessageId: verified.waMessageId, ack: verified.ack }

  console.warn(
    `[whatsapp] the send to ${number} completed but WhatsApp Web returned no message model and none was found in the chat — recording it as sent, without delivery ticks.`,
  )
  return { waMessageId: null, ack: null }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Turns a raw send failure into something the Owner can act on, and kicks off
 * a rebuild when the cause was the session dying underneath us.
 *
 * "Attempted to use detached Frame 194C7DCD..." is a true description of what
 * went wrong and useless on a bill-delivery row; what matters to whoever is
 * standing at the counter is that the bill didn't go, the app noticed, and it
 * is fixing itself.
 */
function describeSendFailure(err: unknown): string {
  if (!isDeadPageError(err)) return describeError(err)
  void restartWhatsAppClient(describeError(err))
  return 'WhatsApp Web reloaded itself mid-send, so this bill did not go out. Reconnecting now — send it again in a moment.'
}
