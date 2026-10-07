import { useEffect, useRef, useState } from 'react'
import type { WebviewElement } from '../types/webview.ts'

type WebViewStatus = 'disconnected' | 'connecting' | 'qr' | 'connected' | 'auth_failure'

interface WebViewState {
  status: WebViewStatus
  qrDataUrl: string | null
  lastError: string | null
}

export function useWhatsAppWebViewStatus(): WebViewState {
  const [state, setState] = useState<WebViewState>({
    status: 'disconnected',
    qrDataUrl: null,
    lastError: null,
  })

  const webviewRef = useRef<WebviewElement | null>(null)

  useEffect(() => {
    let checkInterval: ReturnType<typeof setInterval> | null = null

    const findWebView = () => {
      const views = document.querySelectorAll('webview')
      if (views.length > 0) {
        webviewRef.current = views[0] as WebviewElement
        return true
      }
      return false
    }

    const extractQR = async (view: WebviewElement): Promise<string | null> => {
      try {
        const result = await view.executeJavaScript(`
          (function() {
            const canvas = document.querySelector('canvas[aria-label*="QR"], canvas[data-ref], .qr-code canvas, [data-testid="qrcode"] canvas')
            if (canvas) return canvas.toDataURL('image/png')
            const img = document.querySelector('img[alt*="QR"], img[src^="data:image"]')
            if (img) return img.src
            const pairingDiv = document.querySelector('[data-ref], .landing-window, [data-testid="qr-code"]')
            if (pairingDiv) {
              const c = pairingDiv.querySelector('canvas')
              if (c) return c.toDataURL('image/png')
            }
            return null
          })()
        `)
        return (result as string) ?? null
      } catch {
        return null
      }
    }

    const checkConnectionState = async () => {
      const view = webviewRef.current
      if (!view) return

      try {
        const isConnected = await view.executeJavaScript(`
          (function() {
            const hasChatList = !!document.querySelector('[data-testid="chat-list"], #pane-side, .chatlist')
            const hasMainApp = !!document.querySelector('[data-testid="app"], .app-wrapper, .two')
            const hasQR = !!document.querySelector('canvas[aria-label*="QR"], [data-testid="qrcode"], .qr-code')
            
            if (hasQR) return 'qr'
            if (hasChatList || hasMainApp) return 'connected'
            return 'connecting'
          })()
        `)

        if (isConnected === 'qr') {
          const qrDataUrl = await extractQR(view)
          setState({
            status: 'qr',
            qrDataUrl,
            lastError: null,
          })
        } else if (isConnected === 'connected') {
          setState({
            status: 'connected',
            qrDataUrl: null,
            lastError: null,
          })
        } else {
          setState(prev => ({
            ...prev,
            status: prev.status === 'disconnected' ? 'connecting' : prev.status,
          }))
        }
      } catch {
        setState(prev => ({
          ...prev,
          status: prev.status === 'disconnected' ? 'connecting' : prev.status,
        }))
      }
    }

    const init = () => {
      if (!findWebView()) {
        const retryInterval = setInterval(() => {
          if (findWebView()) {
            clearInterval(retryInterval)
            init()
          }
        }, 500)
        return () => {}
      }

      checkConnectionState()

      checkInterval = setInterval(checkConnectionState, 3000)

      const view = webviewRef.current
      if (!view) return () => {}

      const handleStopLoading = () => checkConnectionState()
      const handleDomReady = () => checkConnectionState()
      const handleFailLoad = (e: Event) => {
        const event = e as unknown as { isMainFrame: boolean; errorCode: number; errorDescription: string }
        if (event.isMainFrame && event.errorCode !== -3) {
          setState({
            status: 'auth_failure',
            qrDataUrl: null,
            lastError: event.errorDescription || `Failed to load (${event.errorCode})`,
          })
        }
      }

      view.addEventListener('did-stop-loading', handleStopLoading)
      view.addEventListener('dom-ready', handleDomReady)
      view.addEventListener('did-fail-load', handleFailLoad)

      return () => {
        view.removeEventListener('did-stop-loading', handleStopLoading)
        view.removeEventListener('dom-ready', handleDomReady)
        view.removeEventListener('did-fail-load', handleFailLoad)
      }
    }

    const cleanup = init()

    return () => {
      if (checkInterval) clearInterval(checkInterval)
      if (cleanup) cleanup()
    }
  }, [])

  return state
}