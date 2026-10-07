import http from 'node:http'
import crypto from 'node:crypto'
import electron from 'electron'
import { DRIVE_SCOPE, type DriveCredentials, exchangeCodeForTokens } from './googleDrive.js'

const { shell } = electron

/**
 * The Owner-authorizes-once flow (PHASE12.md section 2).
 *
 * Google's installed-app flow: open the consent screen in the Owner's real
 * browser, receive the authorization code on a **loopback** redirect. Opening
 * it in the real browser rather than an embedded window is both what Google
 * requires and what lets the Owner see the address bar they are typing their
 * password into.
 *
 * The loopback server reuses the shape `electron/agent/server.ts` already
 * established here — bind 127.0.0.1, let the OS pick the port, compare secrets
 * with `crypto.timingSafeEqual` — rather than inventing a second pattern for
 * the same job.
 *
 * **PKCE** (S256) on top of the client secret, so the authorization code is
 * useless to any other local program that manages to intercept the redirect.
 * Desktop client secrets are not confidential — Google says so plainly — and
 * PKCE is what actually protects this exchange.
 */

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth'

/** How long to wait for the Owner to finish consenting before giving up and closing the port. Long enough to find a password, short enough not to leave a listener open all day. */
const CONSENT_TIMEOUT_MS = 5 * 60 * 1000

function base64Url(buffer: Buffer): string {
  return buffer.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Constant-time where it is cheap to be. `state` is fixed-length hex of our own making, so a length mismatch is a malformed callback rather than a near-miss. */
function statesMatch(received: string | null, expected: string): boolean {
  if (!received || received.length !== expected.length) return false
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
}

function respond(res: http.ServerResponse, title: string, message: string): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${title}</title>` +
      `<body style="font-family: system-ui, sans-serif; padding: 3rem; color: #1e293b">` +
      `<h1 style="font-size:1.25rem">${title}</h1><p>${message}</p></body>`,
  )
}

/**
 * Runs the whole consent round trip and returns a refresh token.
 *
 * Every exit path closes the server: an abandoned browser tab must not leave a
 * port listening for the rest of the session.
 */
export async function authorizeGoogleDrive(
  credentials: DriveCredentials,
): Promise<{ refreshToken: string; accessToken: string }> {
  const codeVerifier = base64Url(crypto.randomBytes(32))
  const codeChallenge = base64Url(crypto.createHash('sha256').update(codeVerifier).digest())
  const state = crypto.randomBytes(16).toString('hex')

  const server = http.createServer()
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const redirectUri = `http://127.0.0.1:${port}`

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('Timed out waiting for Google sign-in. Try connecting again.')),
        CONSENT_TIMEOUT_MS,
      )

      server.on('request', (req, res) => {
        const url = new URL(req.url ?? '/', redirectUri)
        // The browser asks for /favicon.ico off its own bat; answering that as a
        // failed callback would abort a consent that is going perfectly well.
        if (!url.searchParams.has('code') && !url.searchParams.has('error')) {
          res.writeHead(404).end()
          return
        }

        clearTimeout(timer)
        const error = url.searchParams.get('error')
        if (error) {
          respond(res, 'Not connected', 'Google reported: ' + error + '. You can close this tab.')
          reject(new Error(`Google sign-in was declined (${error}).`))
          return
        }
        if (!statesMatch(url.searchParams.get('state'), state)) {
          respond(res, 'Not connected', 'That sign-in did not match this request. You can close this tab.')
          reject(new Error('The Google sign-in response did not match this request.'))
          return
        }

        respond(res, 'Connected to Google Drive', 'You can close this tab and go back to the app.')
        resolve(url.searchParams.get('code') ?? '')
      })

      const consentUrl = new URL(AUTH_ENDPOINT)
      consentUrl.search = new URLSearchParams({
        client_id: credentials.clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: `${DRIVE_SCOPE} https://www.googleapis.com/auth/userinfo.email`,
        // Both are required to be handed a refresh token: without `offline` there
        // is nothing to run a 9pm backup with, and without `consent` Google
        // silently omits it on every authorization after the first.
        access_type: 'offline',
        prompt: 'consent',
        code_challenge: codeChallenge,
        code_challenge_method: 'S256',
        state,
      }).toString()

      void shell.openExternal(consentUrl.toString()).catch((err: unknown) => {
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      })
    })

    if (!code) throw new Error('Google returned no authorization code.')
    return await exchangeCodeForTokens(credentials, code, codeVerifier, redirectUri)
  } finally {
    server.close()
  }
}
