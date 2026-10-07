import { useState } from 'react'
import { useOwnerGate } from '../auth/useOwnerGate.tsx'
import { useWhatsAppStatus } from '../hooks/useWhatsAppStatus.ts'
import { useWhatsAppWebViewStatus } from '../hooks/useWhatsAppWebViewStatus.ts'
import { AppShell } from '../components/AppShell.tsx'
import { BillDeliveryList } from '../components/BillDeliveryList.tsx'
import { WhatsAppWebSlot } from '../components/WhatsAppWebHost.tsx'

type MainTab = 'billSending' | 'messageViewer'

type SessionType = 'agent' | 'webview'

interface SessionPanelProps {
  type: SessionType
  title: string
  description: string
  status: 'disconnected' | 'connecting' | 'qr' | 'connected' | 'auth_failure'
  qrDataUrl: string | null
  loadingPercent?: number | null
  connectedNumber?: string | null
  lastError?: string | null
  onRetry: () => void
  onLogout?: () => void
  busy: boolean
}

function SessionPanel({
  type,
  title,
  description,
  status,
  qrDataUrl,
  loadingPercent,
  connectedNumber,
  lastError,
  onRetry,
  onLogout,
  busy,
}: SessionPanelProps) {
  const BADGE: Record<string, { label: string; dot: string; text: string; bg: string; border: string }> = {
    connected: { label: 'Connected', dot: 'bg-green-500', text: 'text-green-700', bg: 'bg-green-50', border: 'border-green-200' },
    connecting: { label: 'Connecting…', dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200' },
    qr: { label: 'Scan QR', dot: 'bg-amber-500', text: 'text-amber-700', bg: 'bg-amber-50', border: 'border-amber-200' },
    disconnected: { label: 'Disconnected', dot: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200' },
    auth_failure: { label: 'Connection Failed', dot: 'bg-red-500', text: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200' },
  }

  const badge = BADGE[status]

  if (status === 'qr' && qrDataUrl) {
    return (
      <div className="mx-auto mt-6 flex max-w-md flex-col items-center gap-3 rounded border border-slate-200 bg-white p-6">
        <div className="flex items-center gap-2 px-3 py-1.5 rounded-full border border-slate-200 bg-slate-50">
          <span className={`h-2 w-2 rounded-full ${badge.dot}`} />
          <span className={badge.text}>{badge.label}</span>
        </div>
        <p className="text-sm text-slate-600">{description}</p>
        <img src={qrDataUrl} alt={`${title} QR code`} className="h-64 w-64 rounded border border-slate-200" />
        <p className="text-sm text-slate-500">Scan with WhatsApp → Linked Devices → Link a Device</p>
      </div>
    )
  }

  if (status === 'connecting') {
    return (
      <div className="mx-auto mt-6 flex max-w-md flex-col gap-3 rounded border border-amber-200 bg-amber-50 p-6 text-center text-sm text-amber-800">
        <div className="flex items-center justify-center gap-2">
          <span className={`h-2 w-2 rounded-full ${badge.dot} animate-pulse`} />
          <span className={badge.text}>{badge.label}</span>
        </div>
        <p className="text-xs text-amber-700">
          {type === 'agent' 
            ? (typeof loadingPercent === 'number'
                ? `Syncing missed messages (${loadingPercent}%) — This happens after every reconnect and takes a few minutes on busy numbers. Bill sending will work automatically when complete.`
                : 'Connecting to WhatsApp Web…')
            : 'Loading WhatsApp Web…'
          }
        </p>
        {typeof loadingPercent === 'number' && type === 'agent' && (
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-amber-200">
            <div
              className="h-full rounded-full bg-amber-500 transition-all"
              style={{ width: `${Math.min(100, Math.max(0, loadingPercent))}%` }}
            />
          </div>
        )}
        {type === 'agent' && typeof loadingPercent === 'number' && (
          <p className="text-xs text-amber-700">
            WhatsApp hands over every message that arrived while the session was disconnected.
            This runs on any reconnect and takes longer the longer it was away.
            Nothing needs doing — it finishes on its own.
          </p>
        )}
      </div>
    )
  }

  if (status === 'connected') {
    if (type === 'agent') {
      return (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="flex items-center gap-3 bg-slate-50 px-4 py-3 border-b border-slate-200">
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${badge.dot}`} />
              <span className="text-sm font-medium text-green-700">Connected</span>
            </div>
            {connectedNumber && (
              <span className="text-xs text-slate-500 font-mono">+{connectedNumber}</span>
            )}
            {onLogout && (
              <button
                onClick={onLogout}
                className="ml-auto text-xs text-slate-400 underline decoration-dotted hover:text-slate-200"
              >
                Link a different phone
              </button>
            )}
          </div>
          <div className="flex-1 overflow-auto">
            <BillDeliveryList />
          </div>
        </div>
      )
    }

    // WebView connected
    return (
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex items-center gap-3 bg-slate-50 px-4 py-3 border-b border-slate-200">
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${badge.dot}`} />
            <span className="text-sm font-medium text-blue-700">Connected</span>
          </div>
          {onLogout && (
            <button
              onClick={onLogout}
              className="ml-auto rounded border border-red-500 px-2 py-1 text-xs text-red-600 hover:bg-red-500/10 disabled:opacity-50"
              disabled={busy}
            >
              Log out Message Viewer
            </button>
          )}
        </div>
        <div className="flex-1 overflow-hidden">
          <WhatsAppWebSlot />
        </div>
      </div>
    )
  }

  // disconnected or auth_failure
  return (
    <div className="mx-auto mt-6 flex max-w-md flex-col gap-3 rounded border border-red-200 bg-red-50 p-6 text-center">
      <div className="flex items-center justify-center gap-2">
        <span className={`h-2 w-2 rounded-full ${badge.dot}`} />
        <span className={badge.text}>{status === 'auth_failure' ? 'Connection failed.' : 'Disconnected.'}</span>
      </div>
      {lastError && <p className="text-sm text-red-800">{lastError}</p>}
      <p className="text-sm text-red-600">Reconnecting automatically…</p>
      <button
        onClick={onRetry}
        disabled={busy}
        className="mx-auto rounded border border-red-700 px-3 py-1.5 text-sm text-red-700 hover:bg-red-100 disabled:opacity-50"
      >
        Retry now
      </button>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
        active ? 'bg-white text-slate-900 border-b-2 border-transparent' : 'text-slate-400 hover:text-slate-600'
      }`}
    >
      {children}
    </button>
  )
}

/**
 * Owner-only WhatsApp session management screen.
 * 
 * This app uses TWO separate WhatsApp sessions (linked devices):
 * 
 * 1. BILL SENDING SERVICE (Agent) — Background process that sends bill images
 *    to customers and the Owner. Uses whatsapp-web.js + Puppeteer.
 *    Runs continuously, survives app restarts, auto-reconnects.
 * 
 * 2. MESSAGE VIEWER (WebView) — Embedded web.whatsapp.com for viewing chats.
 *    Uses Electron <webview> with persistent partition.
 *    Stays warm in background, loads once per session.
 * 
 * Both require a one-time QR scan (they appear as two separate linked devices
 * on your phone). Once both are scanned, bill sending works automatically
 * and you can view messages in the app.
 */
export function ConnectWhatsAppScreen() {
  const agentState = useWhatsAppStatus()
  const webviewState = useWhatsAppWebViewStatus()
  const [busy, setBusy] = useState(false)
  const [confirmingLogout, setConfirmingLogout] = useState(false)
  const [mainTab, setMainTab] = useState<MainTab>('billSending')
  const { run, gate } = useOwnerGate()

  // Cross-linking guidance
  const agentConnected = agentState.status === 'connected'
  const webviewConnected = webviewState.status === 'connected'
  const needWebviewScan = agentConnected && !webviewConnected && webviewState.status !== 'connecting'
  const needAgentScan = !agentConnected && agentState.status !== 'connecting'

  function handleAgentRetry() {
    run({ title: 'Reconnect Bill Sending', description: 'Enter the Owner password to continue.' }, async () => {
      setBusy(true)
      try {
        await window.api.connectWhatsApp()
      } finally {
        setBusy(false)
      }
    })
  }

  function handleWebViewRetry() {
    run({ title: 'Reload Message Viewer', description: 'Enter the Owner password to continue.' }, async () => {
      setBusy(true)
      try {
        await window.api.resetWhatsAppWebView()
      } finally {
        setBusy(false)
      }
    })
  }

  function handleAgentLogout() {
    run(
      { title: 'Log out Bill Sending', description: 'This disconnects bill sending for the whole shop. Enter the Owner password to continue.' },
      async () => {
        setBusy(true)
        try {
          await window.api.logoutWhatsApp()
        } finally {
          setBusy(false)
          setConfirmingLogout(false)
        }
      },
    )
  }

  function handleWebViewLogout() {
    run(
      { title: 'Log out Message Viewer', description: 'This disconnects the message viewer. Enter the Owner password to continue.' },
      async () => {
        setBusy(true)
        try {
          await window.api.resetWhatsAppWebView()
        } finally {
          setBusy(false)
        }
      },
    )
  }

  function handleLogoutBoth() {
    run(
      { title: 'Logout from Both Sessions', description: 'This disconnects bill sending AND message viewer for the whole shop. Enter the Owner password to continue.' },
      async () => {
        setBusy(true)
        try {
          await window.api.logoutWhatsApp()
          await window.api.resetWhatsAppWebView()
        } finally {
          setBusy(false)
        }
      },
    )
  }

  return (
    <AppShell>
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="border-b border-slate-200 bg-white px-8 py-4">
          <h1 className="text-xl font-semibold text-slate-900">WhatsApp Setup</h1>
          <p className="mt-1 text-sm text-slate-600">
            This app uses <strong>two separate WhatsApp sessions</strong> (they appear as two linked devices on your phone):
          </p>
          <ul className="mt-2 text-sm text-slate-600 space-y-1 list-disc list-inside">
            <li><strong>Bill Sending Service</strong> — Sends bill images to customers & Owner automatically</li>
            <li><strong>Message Viewer</strong> — View & search WhatsApp chats inside this app</li>
          </ul>
          <p className="mt-2 text-xs text-slate-500">
            Scan each QR code once with WhatsApp → Linked Devices → Link a Device. Both stay connected permanently.
          </p>
        </div>

        <div className="flex-1 overflow-hidden flex flex-col">
          {/* Tab Bar */}
          <div className="flex border-b border-slate-200 bg-white px-8 -mb-px">
            <TabButton
              active={mainTab === 'billSending'}
              onClick={() => setMainTab('billSending')}
            >
              Bill Sending
            </TabButton>
            <TabButton
              active={mainTab === 'messageViewer'}
              onClick={() => setMainTab('messageViewer')}
            >
              Message Viewer
            </TabButton>
          </div>

          {/* Tab Panels */}
          <div className="flex-1 overflow-y-auto px-8 py-6">
            {mainTab === 'billSending' && (
              <div className="rounded-xl border border-slate-200 bg-white p-6 flex flex-col h-full">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1">
                    <span className="h-2 w-2 rounded-full bg-emerald-500" />
                    <span className="text-emerald-700 text-sm font-medium">Bill Sending Service</span>
                  </div>
                  {agentState.status === 'connected' && (
                    <span className="text-xs text-slate-500">Runs in background • Auto-reconnects • Survives app restart</span>
                  )}
                </div>
                <SessionPanel
                  type="agent"
                  title="Bill Sending"
                  description="Scan to enable automatic bill sending to customers and the Owner."
                  status={agentState.status}
                  qrDataUrl={agentState.qrDataUrl}
                  loadingPercent={agentState.loadingPercent}
                  connectedNumber={agentState.connectedNumber}
                  lastError={agentState.lastError}
                  onRetry={handleAgentRetry}
                  onLogout={confirmingLogout ? undefined : () => setConfirmingLogout(true)}
                  busy={busy}
                />
                {confirmingLogout && agentState.status === 'connected' && (
                  <div className="flex shrink-0 items-center gap-2 text-xs bg-red-50 border border-red-200 rounded p-3 mt-4">
                    <span className="text-amber-300">Disconnect bill sending for the whole shop?</span>
                    <button
                      onClick={handleAgentLogout}
                      disabled={busy}
                      className="rounded border border-red-500 px-2 py-1 text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                    >
                      Yes, log out
                    </button>
                    <button
                      onClick={() => setConfirmingLogout(false)}
                      disabled={busy}
                      className="rounded border border-slate-500 px-2 py-1 text-slate-300 hover:bg-white/5 disabled:opacity-50"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            )}

            {mainTab === 'messageViewer' && (
              <div className="rounded-xl border border-slate-200 bg-white p-6 flex flex-col h-full">
                <div className="flex items-center gap-3 mb-4">
                  <div className="flex items-center gap-2 rounded-full border border-blue-200 bg-blue-50 px-3 py-1">
                    <span className="h-2 w-2 rounded-full bg-blue-500" />
                    <span className="text-blue-700 text-sm font-medium">Message Viewer (WhatsApp Web)</span>
                  </div>
                  {webviewState.status === 'connected' && (
                    <span className="text-xs text-slate-500">Stays warm in background • Loads once per session</span>
                  )}
                </div>
                <SessionPanel
                  type="webview"
                  title="Message Viewer"
                  description="Scan to view and search your WhatsApp chats inside this app."
                  status={webviewState.status}
                  qrDataUrl={webviewState.qrDataUrl}
                  loadingPercent={null}
                  connectedNumber={null}
                  lastError={webviewState.lastError}
                  onRetry={handleWebViewRetry}
                  onLogout={webviewState.status === 'connected' ? handleWebViewLogout : undefined}
                  busy={busy}
                />

                {/* Cross-linking guidance */}
                {needWebviewScan && (
                  <div className="mt-4 p-4 rounded-lg border border-blue-200 bg-blue-50">
                    <p className="text-sm text-blue-800 font-medium">✓ Bill Sending is connected!</p>
                    <p className="mt-1 text-sm text-blue-700">
                      Scan the QR code in the Bill Sending tab to also enable the Message Viewer. 
                      This is a separate linked device — both work independently.
                    </p>
                  </div>
                )}

                {needAgentScan && webviewConnected && (
                  <div className="mt-4 p-4 rounded-lg border border-emerald-200 bg-emerald-50">
                    <p className="text-sm text-emerald-800 font-medium">✓ Message Viewer is connected!</p>
                    <p className="mt-1 text-sm text-emerald-700">
                      Scan the QR code in the Bill Sending tab to enable automatic bill sending.
                      This is a separate linked device — both work independently.
                    </p>
                  </div>
                )}

                {agentConnected && webviewConnected && (
                  <div className="mt-4 p-4 rounded-lg border border-green-200 bg-green-50">
                    <p className="text-sm text-green-800 font-medium">✓ Both sessions are connected!</p>
                    <p className="mt-1 text-sm text-green-700">
                      Bill sending is active and you can view messages in the Message Viewer tab.
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Logout from Both - shows at bottom when both connected */}
          {(agentConnected && webviewConnected) && (
            <div className="border-t border-slate-200 bg-white px-8 py-4">
              <button
                onClick={handleLogoutBoth}
                disabled={busy}
                className="w-full rounded border border-red-500 px-4 py-2 text-sm text-red-600 hover:bg-red-500/10 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
                </svg>
                Logout from Both Sessions
              </button>
              <p className="mt-2 text-xs text-slate-500 text-center">
                Disconnects bill sending (agent) and message viewer (WebView) — requires Owner password
              </p>
            </div>
          )}
        </div>
      </div>
      {gate}
    </AppShell>
  )
}