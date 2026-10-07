const DEFAULT_COUNTRY_CODE = '91'

/**
 * Normalizes a phone number into the digits-only, country-code-first form
 * whatsapp-web.js needs to resolve a chat id (e.g. '919876543210' — see the
 * format documented on client.ts's `sendWhatsAppMessage`). Parties are
 * stored and displayed as plain 10-digit Indian mobile numbers (see
 * src/db/seed.ts, QuickAddPartyModal) — nobody typing a customer's number
 * at the counter enters a country code — so a bare 10-digit number gets
 * '91' prepended here. A number that already carries a country code is left
 * as-is. This is applied only at WhatsApp-send time in
 * electron/whatsapp/send.ts — it never touches the stored `parties.phone`
 * value or how it's displayed anywhere in the UI.
 */
export function toWhatsAppNumber(rawPhone: string): string {
  const digits = rawPhone.replace(/\D/g, '')
  if (digits.length === 10) return `${DEFAULT_COUNTRY_CODE}${digits}`
  return digits
}
