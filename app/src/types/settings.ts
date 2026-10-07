export interface LabelSize {
  widthMm: number
  heightMm: number
}

/**
 * The shop's own details (PHASE12.md section 1), stored in the `settings`
 * key/value table and read by **both** processes: the renderer prints them as
 * the bill header (src/components/Bill.tsx) and the main process puts them on
 * the WhatsApp bill image and its caption (electron/whatsapp/send.ts).
 *
 * That shared read is the point. Until Phase 12 these lived as two separate
 * sets of hardcoded constants — `src/lib/shopInfo.ts` for the printed bill and
 * `electron/whatsapp/config.ts` for the WhatsApp one — which could drift apart
 * silently, since nothing linked them. Both files are gone; this is the only
 * source now.
 *
 * `shopAddress` is the one optional field (it appears only on the printed
 * bill, and the bill omits the line while it's blank). `ownerWhatsappNumber`
 * is required and can never be saved empty — see `validateOwnerWhatsAppNumber`
 * for why a blank one would be worse than a wrong one.
 */
export interface ShopSettings {
  shopName: string
  shopAddress: string
  shopPhone: string
  /**
   * Where the Owner's copy of every bill is sent. Stored as typed — a bare
   * 10-digit number or a country-code form are both accepted — and normalized
   * to whatsapp-web.js's required form by `toWhatsAppNumber` (src/lib/phone.ts)
   * at send time only, exactly as a customer's `parties.phone` is.
   */
  ownerWhatsappNumber: string
}

/** What the Settings screen submits. Same shape as `ShopSettings` — every field is replaced on each save, so there is no partial-update mode to get wrong. */
export type ShopSettingsInput = ShopSettings
