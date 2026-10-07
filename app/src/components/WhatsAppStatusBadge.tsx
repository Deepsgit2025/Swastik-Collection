import { Link } from 'react-router-dom'
import { usePendingBillCount } from '../hooks/usePendingBillCount.ts'
import { useWhatsAppStatus } from '../hooks/useWhatsAppStatus.ts'
import { useWhatsAppWebViewStatus } from '../hooks/useWhatsAppWebViewStatus.ts'
import type { WhatsAppStatus } from '../types/whatsapp.ts'

const BADGE: Record<WhatsAppStatus, { label: string; dot: string; text: string }> = {
  connected: { label: 'Bill Sending: Connected', dot: 'bg-green-500', text: 'text-green-700' },
  connecting: { label: 'Bill Sending: Connecting…', dot: 'bg-amber-500', text: 'text-amber-700' },
  qr: { label: 'Bill Sending: Scan QR', dot: 'bg-amber-500', text: 'text-amber-700' },
  disconnected: { label: 'Bill Sending: Disconnected', dot: 'bg-red-500', text: 'text-red-700' },
  auth_failure: { label: 'Bill Sending: Failed', dot: 'bg-red-500', text: 'text-red-700' },
}

const WEBVIEW_BADGE: Record<string, { label: string; dot: string; text: string }> = {
  connected: { label: 'Message Viewer: Connected', dot: 'bg-blue-500', text: 'text-blue-700' },
  connecting: { label: 'Message Viewer: Loading…', dot: 'bg-blue-500', text: 'text-blue-700' },
  qr: { label: 'Message Viewer: Scan QR', dot: 'bg-blue-500', text: 'text-blue-700' },
  disconnected: { label: 'Message Viewer: Disconnected', dot: 'bg-red-500', text: 'text-red-700' },
  auth_failure: { label: 'Message Viewer: Failed', dot: 'bg-red-500', text: 'text-red-700' },
}

/**
 * Always-visible connection badge showing both WhatsApp sessions:
 * 1. Bill Sending Service (agent) — critical for bill delivery
 * 2. Message Viewer (WebView) — for viewing chats in the app
 * 
 * Both roles see both statuses. The pending bill count links to the Connect screen.
 */
export function WhatsAppStatusBadge() {
  const agentState = useWhatsAppStatus()
  const webviewState = useWhatsAppWebViewStatus()
  const agentBadge = BADGE[agentState.status]
  const webviewBadge = WEBVIEW_BADGE[webviewState.status]
  const pending = usePendingBillCount()

  // Tooltip combining both statuses
  const tooltipParts = []
  if (agentState.status === 'connected') {
    tooltipParts.push('Bill Sending: Connected')
  } else {
    tooltipParts.push(`Bill Sending: ${agentBadge.label}`)
    if (agentState.lastError) tooltipParts.push(`(${agentState.lastError})`)
  }
  if (webviewState.status === 'connected') {
    tooltipParts.push('Message Viewer: Connected')
  } else {
    tooltipParts.push(`Message Viewer: ${webviewBadge.label}`)
    if (webviewState.lastError) tooltipParts.push(`(${webviewState.lastError})`)
  }

  return (
    <span className="flex items-center gap-1.5">
      {/* Bill Sending Status (Primary) */}
      <span
        className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium"
        title={tooltipParts.join(' • ')}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${agentBadge.dot}`} />
        <span className={agentBadge.text}>{agentBadge.label.replace('Bill Sending: ', '')}</span>
      </span>

      {/* Message Viewer Status (Secondary) */}
      <span
        className="flex items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-medium"
        title={tooltipParts.join(' • ')}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${webviewBadge.dot}`} />
        <span className={webviewBadge.text}>{webviewBadge.label.replace('Message Viewer: ', '')}</span>
      </span>

      {/* Pending Bills Count */}
      {pending > 0 && (
        <Link
          to="/whatsapp"
          className="rounded-full border border-amber-300 bg-amber-50 px-3 py-1 text-xs font-medium text-amber-800 hover:bg-amber-100"
          title="These bills have not reached WhatsApp yet. They send automatically when the session reconnects."
        >
          {pending} bill{pending === 1 ? '' : 's'} not sent
        </Link>
      )}
    </span>
  )
}