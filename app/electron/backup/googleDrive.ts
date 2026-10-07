import fs from 'node:fs'
import { SNAPSHOT_NAME_PREFIX, parseSnapshotFileName } from '../../src/lib/driveSnapshot.js'
import type { RestorePoint } from '../../src/types/backup.js'

/**
 * The slice of the Google Drive v3 API this app uses, over Node's global
 * `fetch` — **no new dependency**.
 *
 * `googleapis` is a very large package to pull in for four REST calls, and this
 * project has already paid, at length, for one heavyweight dependency's install
 * behaviour (see the Puppeteer/Chromium notes in CLAUDE.md). Electron 43 ships a
 * Node with `fetch` built in, and the four calls below are ordinary HTTP.
 *
 * Scope is **`drive.file`**: the app can only ever see files it created itself.
 * That is a property of the grant, not of this code's good behaviour — even a
 * bug here cannot read the Owner's other Drive contents.
 *
 * No direct test against the real API, the same convention as
 * `whatsapp/client.ts` and `whatsapp/billImage.ts`. What *is* tested
 * (`googleDrive.test.ts`, with `fetch` mocked) is the request shapes and the
 * 401-refresh-retry, because those are the parts that break silently.
 */

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token'
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files'
const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo'

/** The dedicated folder every snapshot goes into, so the Owner's Drive root doesn't accumulate database files. */
export const APP_FOLDER_NAME = 'Swastik Collection Billing Backups'

export interface DriveCredentials {
  clientId: string
  clientSecret: string
}

export class DriveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DriveError'
  }
}

/**
 * Turns a failed response into a message worth writing to `backup_log.error`.
 *
 * Google returns its real reason in a JSON body; surfacing "HTTP 403" alone
 * would repeat the mistake this project already made once with a bare
 * `console.error` and no reason attached.
 */
async function describeFailure(response: Response, what: string): Promise<DriveError> {
  let detail = ''
  try {
    const body = await response.text()
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; error_description?: string }
    detail =
      (typeof parsed.error === 'object' ? parsed.error?.message : parsed.error) ??
      parsed.error_description ??
      body.slice(0, 300)
  } catch {
    /* Non-JSON body (an HTML error page, typically) — the status alone will have to do. */
  }
  return new DriveError(`${what} failed (HTTP ${response.status})${detail ? `: ${detail}` : ''}`)
}

/** Exchanges the one-time authorization code from the loopback redirect for tokens. PKCE, so the verifier goes up instead of the code being usable on its own. */
export async function exchangeCodeForTokens(
  credentials: DriveCredentials,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<{ refreshToken: string; accessToken: string }> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      code,
      code_verifier: codeVerifier,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    }),
  })
  if (!response.ok) throw await describeFailure(response, 'Google sign-in')

  const body = (await response.json()) as { refresh_token?: string; access_token?: string }
  if (!body.refresh_token) {
    // Google only issues a refresh token when it is asked to (access_type=offline
    // + prompt=consent, which buildAuthUrl does) and on the *first* consent
    // unless re-prompted. Without one there is nothing to schedule backups with,
    // so this fails loudly now rather than at 9pm.
    throw new DriveError(
      'Google did not return a refresh token. Revoke this app under your Google Account permissions and connect again.',
    )
  }
  return { refreshToken: body.refresh_token, accessToken: body.access_token ?? '' }
}

export async function refreshAccessToken(
  credentials: DriveCredentials,
  refreshToken: string,
): Promise<string> {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!response.ok) throw await describeFailure(response, 'Refreshing the Google Drive authorization')

  const body = (await response.json()) as { access_token?: string }
  if (!body.access_token) throw new DriveError('Google returned no access token.')
  return body.access_token
}

/** The signed-in account, for the "backing up to …" line. Best-effort: a failure here must not stop a connect from succeeding. */
export async function fetchAccountEmail(accessToken: string): Promise<string | null> {
  try {
    const response = await fetch(USERINFO, { headers: { authorization: `Bearer ${accessToken}` } })
    if (!response.ok) return null
    const body = (await response.json()) as { email?: string }
    return body.email ?? null
  } catch {
    return null
  }
}

/**
 * Finds the app's backup folder, creating it if it isn't there.
 *
 * `trashed = false` matters: an Owner who deleted the folder would otherwise
 * get a live id for a trashed folder and uploads that vanish from view. Under
 * `drive.file` this query only ever sees folders this app created, so it cannot
 * accidentally adopt an unrelated folder of the same name.
 */
export async function ensureAppFolder(accessToken: string): Promise<string> {
  const query = `mimeType = 'application/vnd.google-apps.folder' and name = '${APP_FOLDER_NAME}' and trashed = false`
  const search = await fetch(`${DRIVE_FILES}?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!search.ok) throw await describeFailure(search, 'Looking up the Drive backup folder')

  const found = (await search.json()) as { files?: Array<{ id: string }> }
  if (found.files?.length) return found.files[0].id

  const created = await fetch(DRIVE_FILES, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: APP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  })
  if (!created.ok) throw await describeFailure(created, 'Creating the Drive backup folder')

  const body = (await created.json()) as { id?: string }
  if (!body.id) throw new DriveError('Drive created the backup folder but returned no id.')
  return body.id
}

/**
 * Uploads one snapshot and returns its Drive file id.
 *
 * **Resumable, not multipart.** Drive's multipart upload caps at 5MB — which
 * today's 77KB database is nowhere near, and which a shop's database after a few
 * years of sales will quietly cross. A size cliff that appears in year three,
 * on the mechanism the day-30 purge depends on, is worth ten extra lines now.
 *
 * The id is only returned once Drive has confirmed the whole transfer; callers
 * treat its absence as a failed backup, never a successful one.
 */
export async function uploadSnapshot(
  accessToken: string,
  folderId: string,
  filePath: string,
  fileName: string,
): Promise<{ driveFileId: string; sizeBytes: number }> {
  const bytes = fs.readFileSync(filePath)

  const initiate = await fetch(`${DRIVE_UPLOAD}?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json',
      'x-upload-content-type': 'application/octet-stream',
      'x-upload-content-length': String(bytes.byteLength),
    },
    body: JSON.stringify({ name: fileName, parents: [folderId] }),
  })
  if (!initiate.ok) throw await describeFailure(initiate, 'Starting the Drive upload')

  const uploadUrl = initiate.headers.get('location')
  if (!uploadUrl) throw new DriveError('Drive accepted the upload request but returned no upload URL.')

  const put = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.byteLength) },
    body: new Uint8Array(bytes),
  })
  if (!put.ok) throw await describeFailure(put, 'Uploading the backup to Drive')

  const body = (await put.json()) as { id?: string }
  if (!body.id) throw new DriveError('Drive finished the upload but returned no file id.')
  return { driveFileId: body.id, sizeBytes: bytes.byteLength }
}

/**
 * Every snapshot in the app folder, newest first.
 *
 * Sorted by the date parsed out of the **file name** rather than by Drive's
 * `createdTime`: the name records when the snapshot was taken on the shop's
 * clock, `createdTime` records when the bytes finished arriving. A slow or
 * retried upload makes those differ, and a restore list is a list of moments in
 * the shop's history. Anything not matching this app's naming is dropped rather
 * than sorted into an invented position.
 */
export async function listSnapshots(accessToken: string, folderId: string): Promise<RestorePoint[]> {
  const query = `'${folderId}' in parents and trashed = false and name contains '${SNAPSHOT_NAME_PREFIX}'`
  const response = await fetch(
    `${DRIVE_FILES}?q=${encodeURIComponent(query)}&fields=files(id,name,size)&pageSize=100&orderBy=name desc`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  )
  if (!response.ok) throw await describeFailure(response, 'Listing the Drive backups')

  const body = (await response.json()) as { files?: Array<{ id: string; name: string; size?: string }> }
  return (body.files ?? [])
    .map((file) => ({
      driveFileId: file.id,
      fileName: file.name,
      takenAt: parseSnapshotFileName(file.name),
      sizeBytes: file.size != null ? Number(file.size) : null,
    }))
    .filter((point) => point.takenAt != null)
    .sort((a, b) => (a.takenAt! < b.takenAt! ? 1 : -1))
}

/**
 * Permanently deletes one snapshot from Drive — the day-90 half of PHASE12.md
 * section 3's retention rule.
 *
 * `DELETE` rather than moving to the trash, deliberately: the rule is "no
 * snapshot retained anywhere", and a file sitting in the Drive bin for 30 days
 * is retained. The caller (`electron/retention/service.ts`) decides *which*
 * files, and `src/lib/retention.ts` decides when — this only carries it out.
 */
export async function deleteSnapshot(accessToken: string, driveFileId: string): Promise<void> {
  const response = await fetch(`${DRIVE_FILES}/${encodeURIComponent(driveFileId)}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${accessToken}` },
  })
  // 404 means it is already gone, which is the state being asked for — treating
  // that as a failure would leave the sweep retrying a file that does not exist.
  if (!response.ok && response.status !== 404) {
    throw await describeFailure(response, 'Deleting an expired backup from Drive')
  }
}

/** Downloads one snapshot to `destPath`. The caller validates the file before it is allowed anywhere near `app.db`. */
export async function downloadSnapshot(
  accessToken: string,
  driveFileId: string,
  destPath: string,
): Promise<void> {
  const response = await fetch(`${DRIVE_FILES}/${encodeURIComponent(driveFileId)}?alt=media`, {
    headers: { authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) throw await describeFailure(response, 'Downloading the backup from Drive')

  const bytes = Buffer.from(await response.arrayBuffer())
  fs.writeFileSync(destPath, bytes)
}
