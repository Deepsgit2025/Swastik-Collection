import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, ReactNode } from 'react'
import { useOwnerGate } from '../auth/useOwnerGate.tsx'
import { WHATSAPP_WEB_PARTITION } from '../types/whatsapp.ts'
import type { WebviewElement, WebviewFailLoadEvent } from '../types/webview.ts'

const WHATSAPP_WEB_URL = 'https://web.whatsapp.com/'

/** Chromium reports a navigation that something else superseded as -3 (ABORTED). Routine — not a failure worth showing. */
const ERR_ABORTED = -3

/** How long to wait before retrying a failed load, so a flaky connection doesn't spin. */
const RETRY_DELAY_MS = 5_000

/** A crashing guest is retried with this back-off (1s, 2s, 5s ... 30s) so a page that dies on load cannot reload every second forever. */
const CRASH_BACKOFF_MS = [1_000, 2_000, 5_000, 10_000, 30_000]

/**
 * The most our own "Loading WhatsApp Web..." cover may stay up. It exists only to
 * hide the blank guest during a cold start; if the page has not signalled ready
 * by now, showing WhatsApp Web itself is more honest than covering it - the
 * cover has the same words as WhatsApp's own splash, and a cover that could
 * outlive a working page looked like WhatsApp Web being stuck loading forever.
 */
const COVER_MAX_MS = 15_000

/** Where the live view should sit, published by whichever screen currently wants it. */
interface SlotRegistration {
  setSlot: (element: HTMLElement | null) => void
}

const SlotContext = createContext<SlotRegistration | null>(null)

/**
 * Keeps one WhatsApp Web view alive for the whole session, above the router.
 *
 * A `<webview>` rendered inside a screen is destroyed the moment that screen
 * unmounts, so every visit to Connect WhatsApp started WhatsApp Web from
 * nothing — and WhatsApp Web's cold start is slow enough (it re-syncs chats
 * before it will draw them) that the tab looked permanently stuck on its
 * loading splash. Hoisting it here means it loads **once**, the moment an
 * Owner logs in, and stays warm and current behind whatever screen they're
 * on: by the time they open the tab it's already sitting there, and new
 * messages arrive in it live because the page never stopped running.
 *
 * The view can't be moved into the screen when it's needed, either —
 * re-parenting a `<webview>` reloads the guest, which is the very cost this
 * avoids. So it stays put in a fixed-position layer that tracks the screen's
 * slot rectangle, and parks off-screen the rest of the time.
 *
 * It was mounted only for an Owner session, matching the Owner-only screen it
 * appears on. That condition was removed on 2026-08-27, when Owner access
 * became something you hold for as long as one screen is open rather than for
 * a whole login: keyed on it, this view would be torn down and cold-reloaded on
 * every unlock — the exact cost the paragraph above exists to avoid, now paid
 * several times a day instead of once.
 *
 * Loading it unconditionally costs a background page nobody may open. That is
 * the lesser price, and it was already what happened whenever the previous
 * remembered-session launch resumed as the Owner. Note this view is only what
 * the Connect screen *shows*: sending runs in the main process against its own
 * Chrome (electron/whatsapp/client.ts) and never depended on this.
 */
export function WhatsAppWebProvider({ children }: { children: ReactNode }) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  const registration = useMemo<SlotRegistration>(() => ({ setSlot }), [])

  return (
    <SlotContext.Provider value={registration}>
      {children}
      <WhatsAppWebLayer slot={slot} />
    </SlotContext.Provider>
  )
}

/**
 * Marks the region the live WhatsApp Web view should fill. Renders nothing of
 * its own — the view itself lives in `WhatsAppWebProvider` and is positioned
 * over this.
 */
export function WhatsAppWebSlot() {
  const registration = useContext(SlotContext)
  const ref = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    registration?.setSlot(ref.current)
    return () => registration?.setSlot(null)
  }, [registration])

  return <div ref={ref} className="flex flex-1" />
}

function WhatsAppWebLayer({ slot }: { slot: HTMLElement | null }) {
  const viewRef = useRef<WebviewElement | null>(null)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const coverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** Whether the guest has reached `dom-ready` - before that, Electron throws if a webview method such as `reload()` is called. */
  const domReadyRef = useRef(false)
  /** Mirrors `loadError` for the `online` handler, which must not need it as a dependency. */
  const failedRef = useRef(false)
  const crashCount = useRef(0)
  const [rect, setRect] = useState<{ top: number; left: number; width: number; height: number } | null>(null)
  // Our own cover, shown only while the guest is cold-starting. Not driven by
  // `did-start-loading`, which Chromium also fires for every sub-frame and
  // in-page navigation and so kept re-raising an opaque cover over a page that
  // was working.
  const [covered, setCovered] = useState(true)
  const [loadError, setLoadErrorState] = useState<string | null>(null)
  const [relinking, setRelinking] = useState(false)
  const { run: runAsOwner, gate } = useOwnerGate()

  const setLoadError = useCallback((message: string | null) => {
    failedRef.current = message !== null
    setLoadErrorState(message)
  }, [])

  const raiseCover = useCallback(() => {
    setCovered(true)
    if (coverTimer.current) clearTimeout(coverTimer.current)
    coverTimer.current = setTimeout(() => setCovered(false), COVER_MAX_MS)
  }, [])

  const dropCover = useCallback(() => {
    setCovered(false)
    if (coverTimer.current) {
      clearTimeout(coverTimer.current)
      coverTimer.current = null
    }
  }, [])

  const scheduleReloadRef = useRef<(delayMs: number) => void>(() => {})

  const reload = useCallback(() => {
    if (retryTimer.current) {
      clearTimeout(retryTimer.current)
      retryTimer.current = null
    }
    setLoadError(null)
    const view = viewRef.current
    if (!view) return
    try {
      // `reload()` throws until the guest has signalled `dom-ready`. Before
      // then a load is already in flight (or failed before it could be
      // attached), so re-pointing `src` is the call that always works.
      if (domReadyRef.current) view.reload()
      else view.src = WHATSAPP_WEB_URL
      raiseCover()
    } catch {
      // Not attached yet, or the guest is mid-teardown. Try again shortly
      // instead of leaving a cover up with nothing coming to remove it.
      dropCover()
      scheduleReloadRef.current(RETRY_DELAY_MS)
    }
  }, [dropCover, raiseCover, setLoadError])

  const scheduleReload = useCallback(
    (delayMs: number) => {
      if (retryTimer.current) return
      retryTimer.current = setTimeout(() => {
        retryTimer.current = null
        reload()
      }, delayMs)
    },
    [reload],
  )
  scheduleReloadRef.current = scheduleReload

  // The cold-start cover, armed once on mount.
  useEffect(() => {
    raiseCover()
    return () => {
      if (coverTimer.current) clearTimeout(coverTimer.current)
    }
  }, [raiseCover])

  // Track the slot's rectangle so the fixed layer sits exactly over it.
  useLayoutEffect(() => {
    if (!slot) return
    const measure = () => {
      const box = slot.getBoundingClientRect()
      setRect({ top: box.top, left: box.left, width: box.width, height: box.height })
    }
    measure()
    // Guarded: jsdom (the test environment) has no ResizeObserver, and the
    // one-off measurement above is all a test ever needs.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(slot)
    window.addEventListener('resize', measure)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [slot])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return

    const onStopLoading = () => dropCover()
    const onDomReady = () => {
      domReadyRef.current = true
      crashCount.current = 0
      dropCover()
      setLoadError(null)
    }
    const onFailLoad = (event: Event) => {
      const failure = event as WebviewFailLoadEvent
      // Sub-frame failures are WhatsApp's own business, and an aborted load is
      // what a reload or a re-link looks like from here.
      if (!failure.isMainFrame || failure.errorCode === ERR_ABORTED) return
      dropCover()
      setLoadError(failure.errorDescription || `WhatsApp Web could not be reached (${failure.errorCode}).`)
      scheduleReload(RETRY_DELAY_MS)
    }
    // A crashed guest leaves a blank panel behind that never recovers on its
    // own - and since nobody is necessarily looking at this tab when it
    // happens, it has to come back by itself. A deliberate exit is not a crash,
    // and repeated crashes back off rather than reloading every second.
    const onGone = (event: Event) => {
      const reason = (event as Event & { reason?: string }).reason
      if (reason === 'clean-exit') return
      const attempt = Math.min(crashCount.current, CRASH_BACKOFF_MS.length - 1)
      crashCount.current += 1
      domReadyRef.current = false
      dropCover()
      setLoadError('WhatsApp Web stopped unexpectedly. Reloading...')
      scheduleReload(CRASH_BACKOFF_MS[attempt])
    }

    view.addEventListener('did-stop-loading', onStopLoading)
    view.addEventListener('dom-ready', onDomReady)
    view.addEventListener('did-fail-load', onFailLoad)
    view.addEventListener('render-process-gone', onGone)
    return () => {
      view.removeEventListener('did-stop-loading', onStopLoading)
      view.removeEventListener('dom-ready', onDomReady)
      view.removeEventListener('did-fail-load', onFailLoad)
      view.removeEventListener('render-process-gone', onGone)
    }
  }, [dropCover, scheduleReload, setLoadError])

  // Shop internet drops more often than it stays down. Come back on its own
  // rather than leaving a dead panel until someone thinks to press Reload -
  // but only if the view actually failed or never got going. Windows fires
  // `online` on every Wi-Fi handoff, VPN flap and resume from sleep, and
  // hard-reloading a healthy session on each one put WhatsApp Web back on its
  // splash and forced a re-sync; it reconnects its own socket just fine.
  useEffect(() => {
    const onOnline = () => {
      if (failedRef.current || !domReadyRef.current) scheduleReload(500)
    }
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
  }, [scheduleReload])

  useEffect(
    () => () => {
      if (retryTimer.current) clearTimeout(retryTimer.current)
    },
    [],
  )

  /**
   * Wipes this view's linked session and loads it fresh, so WhatsApp Web
   * comes back to its QR screen. Only ever touches this view: bill sending is
   * a different linked device and keeps running throughout.
   */
  function relink() {
    // Clearing the linked session is a delete, so it asks for the Owner password.
    runAsOwner(
      { title: 'Re-link WhatsApp Web view', description: 'This clears the linked WhatsApp Web session shown here. Enter the Owner password to continue.' },
      async () => {
        setRelinking(true)
        try {
          await window.api.resetWhatsAppWebView()
          reload()
        } finally {
          setRelinking(false)
        }
      },
    )
  }

  // Parked *on-screen but invisible* when no screen wants it, not at
  // `left: -20000`. A `display: none` webview stops being laid out, and one
  // moved wholly outside the window can have its rendering throttled by
  // Chromium - either would leave WhatsApp Web unable to finish starting or to
  // receive messages live, which is the whole point of hoisting it up here. At
  // opacity 0 with pointer events off it still counts as visible to the page
  // and can be neither seen nor clicked.
  const active = slot !== null && rect !== null
  const layerStyle: CSSProperties = active
    ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
    : { top: 0, left: 0, width: rect?.width ?? '100%', height: rect?.height ?? '100%', opacity: 0, pointerEvents: 'none' }

  return (
    <div style={layerStyle} className="fixed z-20 flex flex-col overflow-hidden bg-[#111b21]" aria-hidden={!active}>
      <div className="flex items-center gap-3 border-b border-black/40 px-4 py-1.5 text-[11px]">
        <p className="min-w-0 flex-1 truncate text-slate-500">
          web.whatsapp.com — linked separately from bill sending, so anything you do here leaves sales untouched.
        </p>
        <button onClick={reload} className="shrink-0 text-slate-400 hover:text-slate-200">
          Reload
        </button>
        <button
          onClick={relink}
          disabled={relinking}
          className="shrink-0 text-slate-400 underline decoration-dotted hover:text-slate-200 disabled:opacity-50"
        >
          {relinking ? 'Clearing…' : 'Re-link this view'}
        </button>
      </div>

      <div className="relative flex-1">
        <webview
          ref={viewRef}
          src={WHATSAPP_WEB_URL}
          partition={WHATSAPP_WEB_PARTITION}
          // Links inside a chat are handed to the real browser by main.ts's
          // window-open handler; without this the guest can't open them at all.
          // A string, not the boolean React's typings ask for: React 19 drops a
          // boolean on a non-custom element, so the attribute never reached the
          // DOM and no link inside a chat could open.
          {...({ allowpopups: 'true' } as object)}
          // Keeps WhatsApp Web running at full speed when the window is covered
          // or minimised, so messages arrive live instead of on the next look.
          webpreferences="backgroundThrottling=no"
          className="absolute inset-0 h-full w-full"
        />

        {covered && !loadError && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#111b21] text-sm text-slate-400">
            Loading WhatsApp Web…
          </div>
        )}

        {loadError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-[#111b21] px-6 text-center">
            <p className="text-sm text-slate-300">{loadError}</p>
            <p className="max-w-md text-xs text-slate-500">
              Retrying automatically. Bills already sent are unaffected — check them under Bill deliveries.
            </p>
            <button
              onClick={reload}
              className="rounded border border-emerald-600 px-3 py-1.5 text-sm text-emerald-400 hover:bg-emerald-600/10"
            >
              Try now
            </button>
          </div>
        )}
      </div>
      {gate}
    </div>
  )
}
