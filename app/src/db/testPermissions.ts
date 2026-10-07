/**
 * Throwaway dev-only harness (PHASE2.md section 4). Proves `assertPermission`
 * behaves per the central PERMISSIONS table before Phase 3 starts building
 * real screens on top of it. Not a real feature — safe to delete once real
 * screens cover the same ground via their own tests.
 *
 * Run with: npm run test:permissions
 */
import { PERMISSIONS, PermissionError, assertPermission, type Action } from './permissions.js'
import type { Role } from '../types/user.js'

const ROLES: Role[] = ['owner', 'salesman']
const ACTIONS = Object.keys(PERMISSIONS) as Action[]

interface Result {
  action: Action
  role: Role
  expectedAllowed: boolean
  actualAllowed: boolean
  pass: boolean
}

function check(role: Role, action: Action): Result {
  const expectedAllowed = PERMISSIONS[action].includes(role)
  let actualAllowed: boolean
  try {
    assertPermission(role, action)
    actualAllowed = true
  } catch (err) {
    if (!(err instanceof PermissionError)) throw err
    actualAllowed = false
  }
  return { action, role, expectedAllowed, actualAllowed, pass: actualAllowed === expectedAllowed }
}

const results: Result[] = ACTIONS.flatMap((action) => ROLES.map((role) => check(role, action)))

const ACTION_COL = Math.max(...ACTIONS.map((a) => a.length)) + 2
const ROLE_COL = 14

function cell(r: Result): string {
  const verb = r.actualAllowed ? 'ALLOW' : 'DENY '
  const status = r.pass ? 'PASS' : 'FAIL'
  return `${verb} ${status}`.padEnd(ROLE_COL)
}

console.log('\nPermission wrapper self-test — assertPermission(role, action) vs PERMISSIONS table\n')
const header = `${'Action'.padEnd(ACTION_COL)}${'owner'.padEnd(ROLE_COL)}${'salesman'.padEnd(ROLE_COL)}`
console.log(header)
console.log('-'.repeat(header.length))

for (const action of ACTIONS) {
  const owner = results.find((r) => r.action === action && r.role === 'owner')!
  const salesman = results.find((r) => r.action === action && r.role === 'salesman')!
  console.log(`${action.padEnd(ACTION_COL)}${cell(owner)}${cell(salesman)}`)
}

const failures = results.filter((r) => !r.pass)
console.log()
if (failures.length > 0) {
  console.log(`${failures.length} FAILURE(S):`)
  for (const f of failures) {
    console.log(
      `  ${f.role} / ${f.action}: expected ${f.expectedAllowed ? 'ALLOW' : 'DENY'}, got ${f.actualAllowed ? 'ALLOW' : 'DENY'}`,
    )
  }
  process.exitCode = 1
} else {
  console.log(`All ${results.length} checks passed (${ACTIONS.length} actions x ${ROLES.length} roles).`)
}
