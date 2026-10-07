/**
 * Electron session partition backing the embedded WhatsApp Web view
 * (src/components/WhatsAppWebEmbed.tsx). Persistent, so the Owner scans its
 * QR once and it stays linked across restarts, and deliberately separate
 * from the billing session's own Puppeteer profile
 * (electron/whatsapp/client.ts): they link as two independent devices — a
 * phone allows four — so neither can log the other out, and the automatic
 * bill send never depends on this view being open. Shared between the main
 * process (which sets the user agent and permissions on it) and the
 * renderer (which names it on the <webview> tag), so the two can't drift.
 */
export const WHATSAPP_WEB_PARTITION = 'persist:whatsapp-web'

export type WhatsAppStatus = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'auth_failure'

/**
 * Snapshot pushed from the main process (electron/whatsapp/client.ts) to
 * every renderer window whenever the WhatsApp Web session changes state —
 * read by both the Owner-only Connect screen and the always-visible status
 * badge in the app shell (PHASE6.md section 1).
 */
export interface WhatsAppState {
  status: WhatsAppStatus
  /** data: URL of the current QR PNG, set only while status === 'qr'. */
  qrDataUrl: string | null
  /** The linked phone's WhatsApp number, set only while status === 'connected'. */
  connectedNumber: string | null
  /** Human-readable reason for the most recent auth_failure/disconnected event, if any. */
  lastError: string | null
  /**
   * How far WhatsApp Web has got through its offline sync, 0-100, while
   * `status === 'connecting'`. Only present while that sync is actually
   * reporting progress — restoring a session with a big backlog of missed
   * messages can take minutes, and a bare "Connecting to WhatsApp Web…" for
   * that long is indistinguishable from a session that has hung.
   */
  loadingPercent?: number | null
}

/**
 * whatsapp-web.js's own MessageAck values (mirrored here rather than
 * imported, since this file is shared with the renderer, which never depends
 * on whatsapp-web.js directly): -1 error, 0 pending, 1 sent to server,
 * 2 delivered to device, 3 read, 4 played (voice/video notes).
 */
export const MessageAck = {
  Error: -1,
  Pending: 0,
  Sent: 1,
  Delivered: 2,
  Read: 3,
  Played: 4,
} as const

export type MessageAck = (typeof MessageAck)[keyof typeof MessageAck]

/**
 * One bill send to a customer, as shown in the Owner-only bill-delivery view
 * on the Connect WhatsApp screen (src/db/whatsappLog.ts's
 * `getCustomerBillDeliveries`). `ack` is null until the first real
 * `message_ack` event arrives (or for a send that failed before one could).
 */
export interface BillDeliveryRow {
  id: number
  saleId: number
  recipientNumber: string
  status: 'pending' | 'sent' | 'failed'
  /** Why the send failed, shown on the row. Only ever set on `failed`. */
  error: string | null
  waMessageId: string | null
  ack: MessageAck | null
  attemptedAt: string
  partyName: string | null
  grandTotal: number
  saleCreatedAt: string
}

/** Pushed from the main process whenever a real WhatsApp `message_ack` event resolves to a logged send. */
export interface WhatsAppAckEvent {
  waMessageId: string
  ack: MessageAck
}
