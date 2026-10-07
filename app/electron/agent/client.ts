import fs from 'node:fs'
import { spawn } from 'node:child_process'
import electron from 'electron'
import type { AgentEvent, AgentHandshake, AgentSendRequest, AgentSendResponse } from './protocol.js'
import { AGENT_ARGV_FLAG, agentHandshakePath } from './protocol.js'
import { initialWhatsAppState } from '../whatsapp/state.js'
import type { WhatsAppState } from '../../src/types/whatsapp.js'

const { app } = electron

/** How long to wait for a freshly spawned agent to start answering before giving up on this attempt. */
const AGENT_START_TIMEOUT_MS = 30_000
const AGENT_PROBE_INTERVAL_MS = 250
/** Ordinary request budget. Generous because `/send` covers a real WhatsApp send, which `whatsapp/client.ts` already bounds internally. */
const REQUEST_TIMEOUT_MS = 90_000
/** A quick probe is only asking "is anyone there", so it must not inherit the send budget. */
const PROBE_TIMEOUT_MS = 3000
/** Backoff for re-opening the event stream after the agent goes away, capped so a permanently dead agent doesn't spin. */
const STREAM_RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 15_000]

let handshake: AgentHandshake | null = null
let starting: Promise<AgentHandshake> | null = null
let streamRetry = 0
let stopped = false

/**
 * Last state the agent reported.
 *
 * `whatsapp:getState` is a synchronous IPC read feeding the status badge on
 * every screen, and it must not become a network round trip that can hang. The
 * event stream keeps this current, so the badge reads from memory exactly as
 * it did when the session lived in this process.
 */
let cachedState: WhatsAppState = initialWhatsAppState

let stateListeners: Array<(state: WhatsAppState) => void> = []
let ackListeners: Array<(waMessageId: string, ack: number) => void> = []

export function getAgentState(): WhatsAppState {
  return cachedState
}

export function onAgentStateChange(listener: (state: WhatsAppState) => void): () => void {
  stateListeners.push(listener)
  return () => {
    stateListeners = stateListeners.filter((l) => l !== listener)
  }
}

export function onAgentMessageAck(listener: (waMessageId: string, ack: number) => void): () => void {
  ackListeners.push(listener)
  return () => {
    ackListeners = ackListeners.filter((l) => l !== listener)
  }
}

function setCachedState(state: WhatsAppState): void {
  cachedState = state
  for (const listener of stateListeners) listener(state)
}

function readHandshake(): AgentHandshake | null {
  try {
    const raw = fs.readFileSync(agentHandshakePath(app.getPath('userData')), 'utf8')
    const parsed = JSON.parse(raw) as AgentHandshake
    if (!parsed?.port || !parsed?.token) return null
    return parsed
  } catch {
    // Missing on first ever launch, and left behind by a hard-killed agent —
    // both are "no agent to talk to", which `probe` settles for certain.
    return null
  }
}

async function request<T>(
  candidate: AgentHandshake,
  path: string,
  init: { method: string; body?: unknown; timeoutMs?: number },
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? REQUEST_TIMEOUT_MS)
  try {
    const response = await fetch(`http://127.0.0.1:${candidate.port}${path}`, {
      method: init.method,
      headers: {
        authorization: `Bearer ${candidate.token}`,
        ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = (await response.json().catch(() => null)) as { error?: string } | null
      // The agent forwards the real WhatsApp failure text, and `send.ts` writes
      // it into `whatsapp_log.error` — so it has to survive this hop intact
      // rather than being flattened into "request failed".
      throw new Error(detail?.error ?? `The WhatsApp agent returned ${response.status}.`)
    }
    return (await response.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

async function probe(candidate: AgentHandshake): Promise<boolean> {
  try {
    const state = await request<WhatsAppState>(candidate, '/state', {
      method: 'GET',
      timeoutMs: PROBE_TIMEOUT_MS,
    })
    setCachedState(state)
    return true
  } catch {
    return false
  }
}

/**
 * Starts the agent as a genuinely detached process.
 *
 * `detached` + `unref` is what makes it outlive this window — without both,
 * Windows tears the child down with its parent and the split would buy
 * nothing.
 *
 * `ELECTRON_RUN_AS_NODE` is deleted from the child's environment on purpose.
 * VS Code exports it, so every terminal and agent inside it inherits it, and
 * an Electron binary that sees it behaves as a plain Node interpreter —
 * `require('electron')` returns undefined and the process dies at
 * `app.whenReady()`. CLAUDE.md records this having cost a debugging session
 * once already; inheriting it here would have reproduced it in a child process
 * with no console anyone would think to look at.
 */
function spawnAgent(): void {
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  // Packaged, `process.execPath` is the app's own exe and the flag is enough.
  // In dev it is `node_modules/electron/dist/electron.exe`, which needs to be
  // told which app to run — the same argument `electron .` passes.
  const args = app.isPackaged ? [AGENT_ARGV_FLAG] : [app.getAppPath(), AGENT_ARGV_FLAG]

  const child = spawn(process.execPath, args, { detached: true, stdio: 'ignore', env })
  child.unref()
  console.log('[whatsapp] started the WhatsApp agent process')
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Resolves once an agent is reachable — reusing one that is already running
 * (the normal case, and the one that skips the resync entirely) or starting one.
 */
async function ensureAgent(): Promise<AgentHandshake> {
  if (handshake && (await probe(handshake))) return handshake
  if (starting) return starting

  starting = (async () => {
    const existing = readHandshake()
    if (existing && (await probe(existing))) {
      handshake = existing
      return existing
    }

    spawnAgent()
    const deadline = Date.now() + AGENT_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      await delay(AGENT_PROBE_INTERVAL_MS)
      const candidate = readHandshake()
      // A handshake left by the agent that just died still parses, so the
      // probe — not the file's existence — is what proves someone is home.
      if (candidate && (await probe(candidate))) {
        handshake = candidate
        return candidate
      }
    }
    throw new Error('The WhatsApp agent did not start.')
  })().finally(() => {
    starting = null
  })

  return starting
}

function handleEvent(event: AgentEvent): void {
  if (event.type === 'state') setCachedState(event.state)
  else if (event.type === 'ack') for (const listener of ackListeners) listener(event.waMessageId, event.ack)
}

/**
 * Holds the event stream open for the life of the app, re-opening it whenever
 * the agent restarts. A dropped stream means the badge would silently freeze on
 * whatever it last showed, so this never gives up on its own.
 */
async function runEventStream(): Promise<void> {
  while (!stopped) {
    try {
      const current = await ensureAgent()
      const response = await fetch(`http://127.0.0.1:${current.port}/events`, {
        headers: { authorization: `Bearer ${current.token}` },
      })
      if (!response.ok || !response.body) throw new Error(`The agent refused the event stream (${response.status}).`)

      streamRetry = 0
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          for (const line of frame.split('\n')) {
            // ':' prefixed frames are the keep-alive comments, not events.
            if (!line.startsWith('data: ')) continue
            try {
              handleEvent(JSON.parse(line.slice(6)) as AgentEvent)
            } catch (err: unknown) {
              console.error('[whatsapp] could not read an agent event:', err)
            }
          }
          boundary = buffer.indexOf('\n\n')
        }
      }
    } catch (err: unknown) {
      if (stopped) return
      console.warn('[whatsapp] lost the agent event stream:', err instanceof Error ? err.message : err)
    }

    if (stopped) return
    // The agent has gone away, so anything cached about the session is stale —
    // say so rather than leaving a "Connected" badge over a dead session, which
    // is the exact failure this project already fixed once inside the client.
    handshake = null
    setCachedState({
      status: 'disconnected',
      qrDataUrl: null,
      connectedNumber: null,
      lastError: 'The WhatsApp background service is not running. Reconnecting…',
    })
    const wait = STREAM_RETRY_DELAYS_MS[Math.min(streamRetry, STREAM_RETRY_DELAYS_MS.length - 1)]
    streamRetry += 1
    await delay(wait)
  }
}

/** Called once from `app.whenReady()`. Never awaited — a slow agent start must not hold up the billing window. */
export function connectToAgent(): void {
  stopped = false
  void runEventStream()
}

/** Stops this app's *subscription*. It deliberately does not stop the agent: that session outliving this window is the point. */
export function disconnectFromAgent(): void {
  stopped = true
}

export async function requestAgentConnect(): Promise<void> {
  const current = await ensureAgent()
  await request(current, '/connect', { method: 'POST' })
}

export async function requestAgentLogout(): Promise<void> {
  const current = await ensureAgent()
  await request(current, '/logout', { method: 'POST' })
}

export async function sendBillViaAgent(payload: AgentSendRequest): Promise<AgentSendResponse> {
  const current = await ensureAgent()
  return request<AgentSendResponse>(current, '/send', { method: 'POST', body: payload })
}
