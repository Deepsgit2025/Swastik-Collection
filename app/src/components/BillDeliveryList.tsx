import { useMemo, useState } from 'react'
import { useBillDeliveries } from '../hooks/useBillDeliveries.ts'
import { formatCurrency, formatDate } from '../lib/format.ts'
import { MessageAck, type BillDeliveryRow } from '../types/whatsapp.ts'

interface CustomerGroup {
  recipientNumber: string
  partyName: string | null
  bills: BillDeliveryRow[]
}

function groupByCustomer(rows: BillDeliveryRow[]): CustomerGroup[] {
  const groups = new Map<string, CustomerGroup>()
  for (const row of rows) {
    const existing = groups.get(row.recipientNumber)
    if (existing) {
      existing.bills.push(row)
      if (!existing.partyName && row.partyName) existing.partyName = row.partyName
    } else {
      groups.set(row.recipientNumber, { recipientNumber: row.recipientNumber, partyName: row.partyName, bills: [row] })
    }
  }
  // `rows` is already newest-first (getCustomerBillDeliveries), so a Map's
  // insertion order already puts the most-recently-billed customer first.
  return Array.from(groups.values())
}

function initial(name: string | null, phone: string): string {
  return (name?.trim()?.[0] ?? phone.slice(-2, -1)).toUpperCase()
}

function DeliveryTicks({ row }: { row: BillDeliveryRow }) {
  if (row.status === 'pending') {
    return <span className="text-xs text-slate-400">Sending…</span>
  }
  if (row.status === 'failed' || row.ack === MessageAck.Error) {
    return <NotDeliveredMark />
  }
  // status === 'sent' from here on.
  if (row.ack === null || row.ack === MessageAck.Pending || row.ack === MessageAck.Sent) {
    return <Ticks count={1} color="text-slate-400" />
  }
  if (row.ack === MessageAck.Delivered) {
    return <Ticks count={2} color="text-slate-400" />
  }
  // Read or Played.
  return <Ticks count={2} color="text-sky-400" />
}

function NotDeliveredMark() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0 text-red-400" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M8 4.5v4.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="8" cy="11.4" r="0.9" fill="currentColor" />
    </svg>
  )
}

function Ticks({ count, color }: { count: 1 | 2; color: string }) {
  return (
    <svg viewBox="0 0 20 12" className={`h-3.5 w-5 ${color}`} fill="none" aria-hidden="true">
      <path
        d={count === 2 ? 'M1 6.5 L5 10.5 L12 2' : 'M4 6.5 L8 10.5 L15 2'}
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {count === 2 && (
        <path d="M8 6.5 L12 10.5 L19 2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      )}
    </svg>
  )
}

function statusLabel(row: BillDeliveryRow): string {
  if (row.status === 'pending') return 'Sending'
  if (row.status === 'failed' || row.ack === MessageAck.Error) return 'Not delivered'
  if (row.ack === MessageAck.Read || row.ack === MessageAck.Played) return 'Read'
  if (row.ack === MessageAck.Delivered) return 'Delivered'
  // Sent, but no delivery ack has come back yet — either it hasn't reached
  // the customer's phone, or WhatsApp Web never handed us a message id to
  // follow (see electron/whatsapp/client.ts). One grey tick covers both, the
  // same way WhatsApp itself shows a message that has left but not landed.
  return 'Sent'
}

/**
 * Why a send failed, in the words the sender used — a wrong number, a
 * dropped session and a WhatsApp Web change used to be indistinguishable
 * behind a single "Failed to send", leaving the Owner nothing to act on.
 */
function FailureReason({ reason }: { reason: string }) {
  return (
    <p className="mt-0.5 truncate text-[11px] text-red-300/80" title={reason}>
      {reason}
    </p>
  )
}

/**
 * Retries a bill that didn't go out. The Owner's other option on a failed
 * send is the print override, which unlocks the printer while leaving the
 * customer with no bill — this is the one that actually fixes it. Only
 * recipients still marked unsent are re-sent (see
 * `sendSaleWhatsAppNotifications`), so pressing it twice can't put a
 * duplicate bill in anyone's chat.
 */
function ResendButton({ saleId, onResend }: { saleId: number; onResend: (saleId: number) => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  async function handleClick() {
    setBusy(true)
    setFailed(false)
    try {
      await onResend(saleId)
    } catch {
      // The reason is already on the refreshed row; this only needs to say
      // the button's own attempt didn't take.
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      className="shrink-0 rounded border border-emerald-600/60 px-2 py-1 text-[11px] text-emerald-400 hover:bg-emerald-600/10 disabled:opacity-50"
    >
      {busy ? 'Sending…' : failed ? 'Try again' : 'Send again'}
    </button>
  )
}

/**
 * Owner-only bill-delivery view (Connect WhatsApp screen, connected state) —
 * a WhatsApp-style dark list, but scoped to exactly the customers this shop
 * has sent a bill to, built entirely from `whatsapp_log`/`sales`/`parties`
 * (never WhatsApp's real chat list) so no other chat on the linked phone can
 * ever appear here. Each row's ticks reflect the real WhatsApp delivery/read
 * ack for that customer's most recent bill; clicking a row expands their
 * full bill-send history below it.
 */
export function BillDeliveryList() {
  const { deliveries, loading, resend } = useBillDeliveries()
  const [expanded, setExpanded] = useState<string | null>(null)
  const groups = useMemo(() => groupByCustomer(deliveries), [deliveries])

  if (loading) {
    return <div className="p-6 text-sm text-slate-400">Loading bill deliveries…</div>
  }

  if (groups.length === 0) {
    return (
      <div className="p-6 text-sm text-slate-400">
        No bills sent to a customer yet. Every sale with a customer phone number will show up here once it's sent.
      </div>
    )
  }

  return (
    <div className="flex flex-1 flex-col overflow-y-auto bg-[#0b141a]">
      {groups.map((group) => {
        const latest = group.bills[0]
        const isOpen = expanded === group.recipientNumber
        return (
          <div key={group.recipientNumber} className="border-b border-white/5">
            <div className="flex w-full items-center gap-3 px-4 py-3 hover:bg-white/5">
              <button
                onClick={() => setExpanded(isOpen ? null : group.recipientNumber)}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
              >
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-emerald-700 text-sm font-semibold text-white">
                  {initial(group.partyName, group.recipientNumber)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="truncate text-sm font-medium text-slate-100">
                      {group.partyName ?? `+${group.recipientNumber}`}
                    </p>
                    <span className="shrink-0 text-[11px] text-slate-400">{formatDate(latest.attemptedAt)}</span>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <DeliveryTicks row={latest} />
                    <p className="truncate text-xs text-slate-400">
                      Bill for {formatCurrency(latest.grandTotal)} · {statusLabel(latest)}
                    </p>
                  </div>
                  {latest.status === 'failed' && latest.error && <FailureReason reason={latest.error} />}
                </div>
              </button>
              {latest.status === 'failed' && <ResendButton saleId={latest.saleId} onResend={resend} />}
            </div>

            {isOpen && (
              <div className="bg-black/20 px-4 py-2">
                {group.bills.map((bill) => (
                  <div key={bill.id} className="py-2 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-slate-300">
                        <span className="font-medium text-slate-100">{formatCurrency(bill.grandTotal)}</span>{' '}
                        <span className="text-slate-500">· {formatDate(bill.saleCreatedAt)}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <DeliveryTicks row={bill} />
                        <span className="text-slate-400">{statusLabel(bill)}</span>
                        {bill.status === 'failed' && <ResendButton saleId={bill.saleId} onResend={resend} />}
                      </div>
                    </div>
                    {bill.status === 'failed' && bill.error && <FailureReason reason={bill.error} />}
                  </div>
                ))}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
