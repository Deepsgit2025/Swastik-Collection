import { useEffect, useState } from 'react'
import type { WhatsAppState } from '../types/whatsapp.ts'

const UNKNOWN_STATE: WhatsAppState = {
  status: 'connecting',
  qrDataUrl: null,
  connectedNumber: null,
  lastError: null,
}

/**
 * Live WhatsApp Web connection status, shared by the always-visible app
 * shell badge and the Owner-only Connect screen (PHASE6.md section 1).
 * Fetches the current snapshot once on mount, then stays live via the
 * main process's push channel — no polling.
 */
export function useWhatsAppStatus(): WhatsAppState {
  const [state, setState] = useState<WhatsAppState>(UNKNOWN_STATE)

  useEffect(() => {
    let cancelled = false
    window.api.getWhatsAppState().then((initial) => {
      if (!cancelled) setState(initial)
    })
    const unsubscribe = window.api.onWhatsAppState((next) => setState(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return state
}
