// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  APP_FOLDER_NAME,
  DriveError,
  ensureAppFolder,
  exchangeCodeForTokens,
  deleteSnapshot,
  listSnapshots,
  refreshAccessToken,
  uploadSnapshot,
} from './googleDrive.ts'

/**
 * `fetch` is mocked, the same convention `send.test.ts` uses for
 * `sendBillViaAgent`: this file has no business talking to Google, and the
 * network round trip itself needs real credentials that live only on the
 * shop machine.
 *
 * What is worth pinning is the part that breaks *silently* — the request
 * shapes, the resumable-upload handshake, and whether a failure carries
 * Google's own reason forward into `backup_log.error` rather than a bare
 * status code.
 */

const CREDENTIALS = { clientId: 'client-123.apps.googleusercontent.com', clientSecret: 'secret-abc' }
const TOKEN = 'ya29.access-token'

let fetchMock: ReturnType<typeof vi.fn>
let workDir: string

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
  })
}

/** The most recent call, as `[url, init]` — the shape every assertion below reads. */
function lastCall(): [string, RequestInit] {
  const call = fetchMock.mock.calls.at(-1)!
  return [String(call[0]), (call[1] ?? {}) as RequestInit]
}

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swastik-drive-test-'))
})

afterEach(() => {
  vi.unstubAllGlobals()
  fs.rmSync(workDir, { recursive: true, force: true })
})

describe('exchangeCodeForTokens', () => {
  it('posts the PKCE verifier and returns the refresh token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ refresh_token: 'refresh-1', access_token: TOKEN }))

    const result = await exchangeCodeForTokens(CREDENTIALS, 'auth-code', 'the-verifier', 'http://127.0.0.1:5000')

    expect(result).toEqual({ refreshToken: 'refresh-1', accessToken: TOKEN })
    const [url, init] = lastCall()
    expect(url).toBe('https://oauth2.googleapis.com/token')
    const body = new URLSearchParams(init.body as string)
    expect(body.get('code_verifier')).toBe('the-verifier')
    expect(body.get('grant_type')).toBe('authorization_code')
    expect(body.get('redirect_uri')).toBe('http://127.0.0.1:5000')
  })

  /**
   * Without a refresh token there is nothing to run a 9pm backup with. Failing
   * here, loudly, beats discovering it at 9pm when the scheduler has no way to
   * tell anyone.
   */
  it('fails clearly when Google returns no refresh token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: TOKEN }))

    await expect(exchangeCodeForTokens(CREDENTIALS, 'c', 'v', 'http://127.0.0.1:5000')).rejects.toThrow(
      /did not return a refresh token/,
    )
  })

  /** Google puts the real reason in the body; a bare "HTTP 400" in backup_log would be the mistake this project already made once. */
  it('carries Google own error message into the failure', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 }),
    )

    await expect(exchangeCodeForTokens(CREDENTIALS, 'c', 'v', 'http://x')).rejects.toThrow(/invalid_grant/)
  })
})

describe('refreshAccessToken', () => {
  it('exchanges the stored refresh token for an access token', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ access_token: TOKEN }))

    expect(await refreshAccessToken(CREDENTIALS, 'refresh-1')).toBe(TOKEN)
    const body = new URLSearchParams(lastCall()[1].body as string)
    expect(body.get('grant_type')).toBe('refresh_token')
    expect(body.get('refresh_token')).toBe('refresh-1')
  })

  /**
   * The failure an Owner will actually hit a week in if the OAuth consent
   * screen was left in Testing status, where Google expires refresh tokens.
   */
  it('reports a revoked or expired refresh token rather than failing blankly', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'invalid_grant' }, { status: 400 }))

    // One call, both assertions: a Response body can only be read once, so a
    // second invocation against the same mocked Response would see an
    // already-consumed body and lose the reason.
    const failure = await refreshAccessToken(CREDENTIALS, 'stale').catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(DriveError)
    expect((failure as Error).message).toMatch(/invalid_grant/)
  })
})

describe('ensureAppFolder', () => {
  it('reuses an existing folder', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ files: [{ id: 'folder-1' }] }))

    expect(await ensureAppFolder(TOKEN)).toBe('folder-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [url, init] = lastCall()
    expect(url).toContain(encodeURIComponent(APP_FOLDER_NAME))
    // A trashed folder would otherwise be adopted, and every upload after that
    // would land somewhere the Owner cannot see.
    expect(decodeURIComponent(url)).toContain('trashed = false')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('creates the folder when there is not one yet', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ files: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'folder-new' }))

    expect(await ensureAppFolder(TOKEN)).toBe('folder-new')
    const [, init] = lastCall()
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toMatchObject({
      name: APP_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
    })
  })
})

describe('uploadSnapshot', () => {
  function writeSnapshot(bytes = 2048): string {
    const filePath = path.join(workDir, 'snapshot.db')
    fs.writeFileSync(filePath, Buffer.alloc(bytes, 7))
    return filePath
  }

  /**
   * Resumable, not multipart. Multipart caps at 5MB — which a shop database
   * will quietly cross after a few years, on the exact mechanism the day-30
   * purge depends on.
   */
  it('initiates a resumable upload, then PUTs the bytes to the returned URL', async () => {
    const filePath = writeSnapshot()
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { location: 'https://upload.example/session-1' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'drive-file-1' }))

    const result = await uploadSnapshot(TOKEN, 'folder-1', filePath, 'swastik-backup-2026-08-26-2100.db')

    expect(result).toEqual({ driveFileId: 'drive-file-1', sizeBytes: 2048 })

    const initiate = fetchMock.mock.calls[0]
    expect(String(initiate[0])).toContain('uploadType=resumable')
    const initiateInit = initiate[1] as RequestInit
    expect((initiateInit.headers as Record<string, string>)['x-upload-content-length']).toBe('2048')
    expect(JSON.parse(initiateInit.body as string)).toMatchObject({
      name: 'swastik-backup-2026-08-26-2100.db',
      parents: ['folder-1'],
    })

    const [putUrl, putInit] = lastCall()
    expect(putUrl).toBe('https://upload.example/session-1')
    expect(putInit.method).toBe('PUT')
  })

  it('fails when Drive accepts the request but returns no upload URL', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }))

    await expect(uploadSnapshot(TOKEN, 'folder-1', writeSnapshot(), 'x.db')).rejects.toThrow(/no upload URL/)
  })

  /**
   * The id is the only proof the bytes are in Drive, and `recordBackupResult`
   * turns its presence into a `success` row the day-30 purge later acts on. A
   * transfer that ends without one must not be able to read as a success.
   */
  it('fails when the transfer finishes without a file id', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { location: 'https://upload.example/session-1' } }),
      )
      .mockResolvedValueOnce(jsonResponse({}))

    await expect(uploadSnapshot(TOKEN, 'folder-1', writeSnapshot(), 'x.db')).rejects.toThrow(/no file id/)
  })

  it('reports the reason when the bytes are rejected', async () => {
    fetchMock
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { location: 'https://upload.example/session-1' } }),
      )
      .mockResolvedValueOnce(jsonResponse({ error: { message: 'The user has exceeded their Drive quota.' } }, { status: 403 }))

    await expect(uploadSnapshot(TOKEN, 'folder-1', writeSnapshot(), 'x.db')).rejects.toThrow(/exceeded their Drive quota/)
  })
})

describe('listSnapshots', () => {
  it('dates each snapshot from its file name and sorts newest first', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        files: [
          { id: 'b', name: 'swastik-backup-2026-08-20-2100.db', size: '76000' },
          { id: 'a', name: 'swastik-backup-2026-08-26-2100.db', size: '81920' },
        ],
      }),
    )

    const points = await listSnapshots(TOKEN, 'folder-1')

    expect(points.map((p) => p.driveFileId)).toEqual(['a', 'b'])
    expect(points[0].takenAt).toBe('2026-08-26 21:00')
    expect(points[0].sizeBytes).toBe(81920)
  })

  /**
   * Anything this app did not write has no place in a restore list — offering
   * to overwrite the shop database with a stray file would be worse than not
   * showing it.
   */
  it('drops files that are not this app snapshots', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        files: [
          { id: 'a', name: 'swastik-backup-2026-08-26-2100.db', size: '81920' },
          { id: 'x', name: 'holiday-photo.jpg', size: '900' },
        ],
      }),
    )

    const points = await listSnapshots(TOKEN, 'folder-1')
    expect(points).toHaveLength(1)
    expect(points[0].driveFileId).toBe('a')
  })

  it('scopes the query to the app folder and excludes trashed files', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ files: [] }))

    await listSnapshots(TOKEN, 'folder-1')

    const query = decodeURIComponent(lastCall()[0])
    expect(query).toContain("'folder-1' in parents")
    expect(query).toContain('trashed = false')
  })
})

describe('deleteSnapshot', () => {
  /**
   * The day-90 half of the retention rule. `DELETE` rather than a move to the
   * trash: "no snapshot retained anywhere" is not satisfied by a file sitting
   * in the Drive bin for another 30 days.
   */
  it('issues a real DELETE for the file', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }))

    await deleteSnapshot(TOKEN, 'drive-file-1')

    const [url, init] = lastCall()
    expect(url).toContain('drive-file-1')
    expect(url).not.toContain('trash')
    expect(init.method).toBe('DELETE')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`)
  })

  /** Already gone is the state being asked for; treating it as a failure would leave the sweep retrying a file that does not exist. */
  it('treats a missing file as done rather than as a failure', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 404 }))
    await expect(deleteSnapshot(TOKEN, 'already-gone')).resolves.toBeUndefined()
  })

  it('reports a refusal with its reason', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'Insufficient permissions' } }, { status: 403 }))

    await expect(deleteSnapshot(TOKEN, 'drive-file-1')).rejects.toThrow(/Insufficient permissions/)
  })
})
