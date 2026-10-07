/**
 * Pure validators for the Phase 12 Settings screen — shop details, the Owner's
 * WhatsApp number, and the fields of a new Salesman login.
 *
 * Same two-layer discipline as `saleMath.ts` / `paymentMath.ts` /
 * `expenseMath.ts`: `SettingsScreen` calls these for inline errors and
 * `setShopSettings`/`createSalesmanUser` (src/db/settings.ts, src/db/users.ts)
 * call the identical functions to gate the write. The screen's message and the
 * write's rejection therefore can't drift, and the backend check is the one
 * that actually enforces anything — a patched renderer skipping the inline
 * error still hits the same rule.
 *
 * Every function returns `null` when the value is acceptable, or the message
 * to show when it isn't.
 */

const MAX_SHOP_NAME_LENGTH = 80
const MAX_SHOP_ADDRESS_LENGTH = 200
const MAX_FULL_NAME_LENGTH = 60
const MIN_USERNAME_LENGTH = 3
const MAX_USERNAME_LENGTH = 32
const MIN_PASSWORD_LENGTH = 6

/** `[a-z0-9._-]` only. `verifyLogin` matches `users.username` exactly, so a stray capital at creation time becomes a login nobody can reproduce. */
const USERNAME_PATTERN = /^[a-z0-9._-]+$/

export function validateShopName(name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed) return 'Shop name is required — it prints at the top of every bill.'
  if (trimmed.length > MAX_SHOP_NAME_LENGTH) {
    return `Shop name must be ${MAX_SHOP_NAME_LENGTH} characters or fewer.`
  }
  return null
}

/** Optional: the printed bill simply omits the address line while this is blank. */
export function validateShopAddress(address: string): string | null {
  if (address.trim().length > MAX_SHOP_ADDRESS_LENGTH) {
    return `Address must be ${MAX_SHOP_ADDRESS_LENGTH} characters or fewer.`
  }
  return null
}

export function validateShopPhone(phone: string): string | null {
  const trimmed = phone.trim()
  if (!trimmed) return 'Shop phone is required — it prints on the bill and on the WhatsApp bill image.'
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) {
    return 'Shop phone must be a 10-digit number (a country code is fine too).'
  }
  return null
}

/**
 * Required, and deliberately stricter than the shop phone above about being
 * present at all.
 *
 * A blank Owner number is worse than a wrong one. `getSalesAwaitingWhatsApp`
 * (src/db/whatsappLog.ts) treats any sale with `whatsapp_owner_sent = 0` as
 * still owed, unconditionally — there is no "no Owner number on file" case the
 * way there is for a walk-in customer with no phone. So saving this blank
 * would park every future sale in the "N bills not sent" chip permanently,
 * with no way to clear it short of the Owner override on each one.
 *
 * A bare 10-digit number is accepted and gets its country code at send time
 * via `toWhatsAppNumber` (src/lib/phone.ts), the same normalization a
 * customer's `parties.phone` goes through — nobody should have to know
 * whatsapp-web.js's addressing format to fill in a settings field.
 */
export function validateOwnerWhatsAppNumber(number: string): string | null {
  const trimmed = number.trim()
  if (!trimmed) {
    return "The Owner's WhatsApp number is required — without it, every bill stays queued as undelivered."
  }
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 10 || digits.length > 15) {
    return "The Owner's WhatsApp number must be a 10-digit mobile number (a country code is fine too)."
  }
  return null
}

export function validateFullName(fullName: string): string | null {
  const trimmed = fullName.trim()
  if (!trimmed) return 'Full name is required.'
  if (trimmed.length > MAX_FULL_NAME_LENGTH) {
    return `Full name must be ${MAX_FULL_NAME_LENGTH} characters or fewer.`
  }
  return null
}

export function validateUsername(username: string): string | null {
  const trimmed = username.trim()
  if (!trimmed) return 'Username is required.'
  if (trimmed.length < MIN_USERNAME_LENGTH || trimmed.length > MAX_USERNAME_LENGTH) {
    return `Username must be between ${MIN_USERNAME_LENGTH} and ${MAX_USERNAME_LENGTH} characters.`
  }
  if (!USERNAME_PATTERN.test(trimmed)) {
    return 'Username can only use lowercase letters, numbers, dots, dashes and underscores.'
  }
  return null
}

export function validatePassword(password: string): string | null {
  if (!password) return 'Password is required.'
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`
  }
  return null
}
