import path from 'node:path'
import type { WhatsAppState } from '../../src/types/whatsapp.js'

/**
 * The contract between the two processes this app now runs as.
 *
 * The WhatsApp session used to live and die with the billing window: it was
 * started on `app.whenReady()` and destroyed on `before-quit`. That made every
 * app close an offline period, and WhatsApp charges for offline periods — on
 * reconnect it re-delivers every message that arrived while the linked device
 * was away, which on a busy shop number takes minutes during which nothing can
 * be sent. Closing the app at night therefore guaranteed the "handing over the
 * messages that arrived while this session was disconnected" screen every
 * single morning.
 *
 * So the session now lives in its own process, launched from the same binary
 * with `--wa-agent`, started at login, and outliving every billing window. The
 * app talks to it over loopback HTTP and is free to come and go.
 *
 * Deliberately, the agent owns **no database**. It holds the session and sends
 * what it is told to send; every `whatsapp_log`/`sales` write stays in the app
 * process, so better-sqlite3 keeps exactly one writer and none of
 * `src/db/whatsappLog.ts` had to change. It also means the agent has nothing
 * to do while the app is closed except stay linked — which is the whole point.
 */
export const AGENT_ARGV_FLAG = '--wa-agent'

/**
 * Written by the agent once it is listening, read by the app to find it.
 * Under `userData` alongside `app.db` and `wwebjs_auth`, so both processes
 * derive the same path from `app.getPath('userData')` without either having to
 * be told where the other put it.
 */
export function agentHandshakePath(userDataPath: string): string {
  return path.join(userDataPath, 'wa-agent.json')
}

export interface AgentHandshake {
  /** Loopback port the agent is listening on — chosen by the OS, never fixed, so a busy port can't wedge startup. */
  port: number
  /** Random per-launch secret every request must present. See `authorize` in server.ts for why this exists at all. */
  token: string
  /** The agent's own pid, so a stale handshake file from a dead process is recognisable. */
  pid: number
}

/** `POST /send` — the app renders the bill PNG (it needs Electron's BrowserWindow) and hands the agent the bytes. */
export interface AgentSendRequest {
  /** Digits-only, country-code-first, already normalized by `toWhatsAppNumber`. */
  number: string
  base64Png: string
  filename: string
  caption: string
}

/** Mirrors `WhatsAppSendResult` in whatsapp/client.ts — a null id is a missing delivery tick, never a missing message. */
export interface AgentSendResponse {
  waMessageId: string | null
  ack: number | null
}

/** `GET /events` — one SSE stream carrying both of the push channels the renderer already subscribes to. */
export type AgentEvent =
  | { type: 'state'; state: WhatsAppState }
  | { type: 'ack'; waMessageId: string; ack: number }
