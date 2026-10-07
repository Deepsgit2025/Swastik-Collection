import fs from 'node:fs'
import path from 'node:path'
import electron from 'electron'

const { app } = electron

/**
 * Where the Google Drive authorization lives (PHASE12.md section 2 — "token
 * persisted").
 *
 * Under `userData` alongside `app.db` and `wa-agent.json`, so it survives an
 * app update and is protected by exactly the same filesystem permissions the
 * shop's database already relies on — this adds no new secret to look after
 * that isn't already implied by `app.db` being readable.
 *
 * **Nothing in this file is ever sent to the renderer.** The Settings screen
 * learns `connected: boolean` and the account email and nothing else, the same
 * discipline that keeps `password_hash` out of `UserListRow`. A refresh token
 * is a long-lived credential to the Owner's Drive; there is no reason for it to
 * cross the IPC boundary, so it doesn't.
 *
 * Deliberately **not** in the `settings` table: a restore rebuilds `app.db`
 * from a snapshot, and the Drive authorization is a property of *this machine*,
 * not of the data. Storing it in the database would mean restoring an old
 * backup silently reverted (or revoked) the connection that produced it.
 */
export interface DriveAuth {
  refreshToken: string
  /** The Google account that authorized, when the id-token/userinfo lookup produced one. Shown so the Owner can see which Drive this backs up to. */
  email: string | null
  /** The app's dedicated Drive folder, cached so it isn't looked up on every backup. Re-created if it has since been deleted. */
  folderId: string | null
}

function authFilePath(): string {
  return path.join(app.getPath('userData'), 'drive-auth.json')
}

export function readDriveAuth(): DriveAuth | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(authFilePath(), 'utf8')) as DriveAuth
    // A file with no refresh token is not a usable authorization, however
    // well-formed it is — treat it as absent rather than half-connected.
    return parsed?.refreshToken ? parsed : null
  } catch {
    return null
  }
}

export function writeDriveAuth(auth: DriveAuth): void {
  // mode 0600: on Windows this is largely advisory, but it costs nothing and is
  // correct on the platforms where it is enforced.
  fs.writeFileSync(authFilePath(), JSON.stringify(auth, null, 2), { encoding: 'utf8', mode: 0o600 })
}

/** Drops the stored authorization. The grant itself still exists on Google's side until the Owner revokes it in their account — the Disconnect copy says so rather than implying otherwise. */
export function clearDriveAuth(): void {
  try {
    fs.rmSync(authFilePath(), { force: true })
  } catch {
    /* Already gone, or unreadable — either way there is nothing usable left. */
  }
}

/** Records the app folder id without disturbing the token, for the first backup after a connect (or after the folder had to be re-created). */
export function rememberFolderId(folderId: string): void {
  const auth = readDriveAuth()
  if (!auth) return
  writeDriveAuth({ ...auth, folderId })
}
