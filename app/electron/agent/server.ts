import http from 'node:http'
import net from 'node:net'
import crypto from 'node:crypto'
import fs from 'node:fs'
import electron from 'electron'
import whatsappWeb from 'whatsapp-web.js'
import type { AgentEvent, AgentHandshake, AgentSendRequest, AgentSendResponse } from './protocol.js'
import { agentHandshakePath } from './protocol.js'
import {
  getWhatsAppState,
  logoutWhatsAppSession,
  onWhatsAppMessageAck,
  onWhatsAppStateChange,
  releaseStaleWhatsAppBrowsers,
  sendWhatsAppMessage,
  startWhatsAppClient,
  stopWhatsAppClient,
} from '../whatsapp/client.js'

const { MessageMedia } = whatsappWeb
const { app } = electron

/** Largest `POST /send` body accepted. A bill PNG is tens of KB; this is only here so a malformed request can't grow unbounded in memory. */
const MAX_BODY_BYTES = 16 * 1024 * 1024
/** SSE comment interval. Loopback connections rarely idle out, but a dead stream that nobody notices would silently stop the app's live badge. */
const HEARTBEAT_MS = 30_000

let openStreams: http.ServerResponse[] = []

/**
 * Every request must present the token from the handshake file.
 *
 * The server is bound to 127.0.0.1, so this is not defending against the
 * network — it is defending against *other local programs*, which can reach a
 * loopback port just as easily as this app can. Reading the token requires
 * read access to the user's own `userData` directory, which is the same bar
 * already protecting `app.db` itself, so this adds no new secret to look after
 * while making the port useless to anything that hasn't cleared that bar.
 */
function authorize(req: http.IncomingMessage, token: string): boolean {
  const header = req.headers.authorization
  if (!header) return false
  const expected = `Bearer ${token}`
  // Both sides are fixed-length hex of our own making, so a length mismatch is
  // a malformed header rather than a near-miss worth constant-time care.
  if (header.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(expected))
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large.'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(payload)
}

function broadcast(event: AgentEvent): void {
  const frame = `data: ${JSON.stringify(event)}\n\n`
  for (const stream of openStreams) {
    // A client that has gone away without us noticing yet — the write throws
    // rather than the stream having been removed, so one dead subscriber can't
    // take down the broadcast to the others.
    try {
      stream.write(frame)
    } catch {
      /* dropped on its own 'close' handler */
    }
  }
}

function handleEventStream(req: http.IncomingMessage, res: http.ServerResponse): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  // The current state up front, so a reconnecting app doesn't have to make a
  // second call to find out where the session stands.
  res.write(`data: ${JSON.stringify({ type: 'state', state: getWhatsAppState() } satisfies AgentEvent)}\n\n`)
  openStreams.push(res)

  const heartbeat = setInterval(() => {
    try {
      res.write(': keep-alive\n\n')
    } catch {
      /* cleaned up below */
    }
  }, HEARTBEAT_MS)

  const drop = (): void => {
    clearInterval(heartbeat)
    openStreams = openStreams.filter((stream) => stream !== res)
  }
  req.on('close', drop)
  res.on('close', drop)
  res.on('error', drop)
}

async function handleSend(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const raw = await readBody(req)
  const body = JSON.parse(raw) as AgentSendRequest
  if (!body?.number || !body?.base64Png) {
    sendJson(res, 400, { error: 'number and base64Png are required.' })
    return
  }
  const media = new MessageMedia('image/png', body.base64Png, body.filename ?? 'bill.png')
  // Errors deliberately surface as a 500 with the original message rather than
  // a generic one: `send.ts` writes whatever comes back into
  // `whatsapp_log.error`, and that column is what every WhatsApp bug in this
  // project was ultimately diagnosed from.
  const result = await sendWhatsAppMessage(body.number, media, { caption: body.caption })
  sendJson(res, 200, result satisfies AgentSendResponse)
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = req.url ?? '/'

  if (url === '/state' && req.method === 'GET') {
    sendJson(res, 200, getWhatsAppState())
    return
  }
  if (url === '/events' && req.method === 'GET') {
    handleEventStream(req, res)
    return
  }
  if (url === '/connect' && req.method === 'POST') {
    startWhatsAppClient()
    sendJson(res, 200, { ok: true })
    return
  }
  if (url === '/logout' && req.method === 'POST') {
    await logoutWhatsAppSession()
    sendJson(res, 200, { ok: true })
    return
  }
  if (url === '/send' && req.method === 'POST') {
    await handleSend(req, res)
    return
  }
  sendJson(res, 404, { error: `No such agent route: ${req.method} ${url}` })
}

/**
 * The port that decides which process holds the session.
 *
 * `anotherAgentIsLive` below asks politely: it reads a handshake file and
 * probes it. But an agent writes that file only after it has stood down a
 * rival, swept the profile and bound its own port — a second or more later —
 * and two agents starting inside that window both ask the question, both get
 * "nobody", and both go on to launch Chrome against one profile. The loser
 * reports *"The browser is already running for …\wwebjs_auth\session"*, and
 * two agents then fight over the session for as long as both are up.
 *
 * A bound port has none of those properties. It cannot be shared, it cannot go
 * stale, and the operating system releases it however the process dies —
 * clean exit, crash, hard kill or power cut — so there is no leftover state to
 * interpret. The agent claims it before doing anything else, and a process
 * that cannot claim it is by definition not the one holding the session.
 *
 * Fixed rather than OS-assigned, because a lock nobody can find is not a lock.
 * Nothing is ever served on it; it is held open purely to be unavailable.
 */
const SINGLETON_PORT = 47921
let sessionLock: net.Server | null = null

/** Resolves with the held lock, or null if someone else has it. */
function claimSessionLock(): Promise<net.Server | null> {
  return new Promise<net.Server | null>((resolve) => {
    const lock = net.createServer()
    lock.once('error', () => resolve(null))
    lock.listen(SINGLETON_PORT, '127.0.0.1', () => resolve(lock))
  })
}

/**
 * True when a *different*, still-answering agent owns the session already.
 * The handshake file alone doesn't settle it — a hard-killed agent leaves one
 * behind that parses perfectly — so this asks the port whether anyone is home.
 */
async function anotherAgentIsLive(handshakeFile: string): Promise<boolean> {
  let existing: AgentHandshake
  try {
    existing = JSON.parse(fs.readFileSync(handshakeFile, 'utf8')) as AgentHandshake
  } catch {
    return false
  }
  if (!existing?.port || !existing?.token || existing.pid === process.pid) return false

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3000)
  try {
    const response = await fetch(`http://127.0.0.1:${existing.port}/state`, {
      headers: { authorization: `Bearer ${existing.token}` },
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Runs this process as the WhatsApp session holder and nothing else — no
 * window, no database, no migrations. Entered from `main.ts` when the binary
 * is started with `--wa-agent`.
 */
export async function runWhatsAppAgent(): Promise<void> {
  const token = crypto.randomBytes(32).toString('hex')
  const handshakeFile = agentHandshakePath(app.getPath('userData'))

  // Two agents would launch two Chromes against one LocalAuth profile, and
  // Chrome allows one process per `--user-data-dir` — the second wedges on a
  // locked directory and `initialize()` hangs forever, since it navigates with
  // `timeout: 0`. That is the failure this project already spent a session
  // diagnosing, so a duplicate agent stands down instead of racing.
  //
  // Both checks run, and they cover different things. The lock is the one that
  // is airtight, and it settles the race two agents starting together used to
  // lose. The probe still earns its place: it also recognises an agent from a
  // build that predates the lock and doesn't bind it — exactly the situation
  // during the upgrade that introduces this — and it is what tells us, when
  // the lock is refused, whether the port belongs to an agent at all.
  sessionLock = await claimSessionLock()
  if (!sessionLock) {
    if (await anotherAgentIsLive(handshakeFile)) {
      console.log('[wa-agent] another agent already holds the session — exiting')
      app.quit()
      return
    }
    // A fixed port can be taken by anything, and standing down for an unrelated
    // program would leave the shop with no WhatsApp at all — the worse failure
    // of the two, and one nobody would think to look for. Carry on unlocked;
    // `ensureProfileFree` still stands between this and a second Chrome.
    console.warn(`[wa-agent] port ${SINGLETON_PORT} is held by something that isn't an agent — continuing without the lock`)
  } else if (await anotherAgentIsLive(handshakeFile)) {
    console.log('[wa-agent] an older agent still holds the session — exiting')
    sessionLock.close()
    app.quit()
    return
  }

  // Same reasoning as the app's own startup: a Chrome left holding the profile
  // by a previous agent would make every connect attempt hang on a locked
  // profile directory. This matters less now that only this process ever
  // launches Chrome, but a hard kill still skips every teardown path.
  await releaseStaleWhatsAppBrowsers()

  onWhatsAppStateChange((state) => {
    console.log(`[wa-agent] status -> ${state.status}${state.lastError ? ` (${state.lastError})` : ''}`)
    broadcast({ type: 'state', state })
  })
  // Forwarded raw. Matching an ack back to its `whatsapp_log` row is a database
  // operation, so it stays in the app process where the database is.
  onWhatsAppMessageAck((waMessageId, ack) => broadcast({ type: 'ack', waMessageId, ack }))

  const server = http.createServer((req, res) => {
    if (!authorize(req, token)) {
      sendJson(res, 401, { error: 'Bad or missing agent token.' })
      return
    }
    void route(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error(`[wa-agent] ${req.method} ${req.url} failed:`, err)
      if (!res.headersSent) sendJson(res, 500, { error: message })
      else res.end()
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    // Port 0: the OS picks a free one and the app reads it from the handshake,
    // so a port already taken by something else can never wedge startup.
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The agent could not determine its own port.')

  const handshake: AgentHandshake = { port: address.port, token, pid: process.pid }
  fs.writeFileSync(handshakeFile, JSON.stringify(handshake), { encoding: 'utf8', mode: 0o600 })
  console.log(`[wa-agent] listening on 127.0.0.1:${address.port} (pid ${process.pid})`)

  startWhatsAppClient()

  // Only a deliberate shutdown gets here — closing a billing window no longer
  // reaches this process at all, which is the entire point of the split.
  app.on('before-quit', () => {
    try {
      fs.rmSync(handshakeFile, { force: true })
    } catch {
      /* a stale handshake is recoverable; the app probes before trusting it */
    }
    // Released explicitly on the way out so a replacement agent can claim it
    // without waiting on the socket's own cleanup. Every other way this process
    // can end releases it too, which is the reason the lock is a port.
    sessionLock?.close()
    sessionLock = null
    void stopWhatsAppClient()
  })
}
