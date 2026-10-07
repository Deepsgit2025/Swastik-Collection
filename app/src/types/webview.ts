/**
 * The parts of Electron's `<webview>` tag that React's own typings don't
 * cover.
 *
 * React already declares the JSX element and its attributes
 * (`WebViewHTMLAttributes`), but types the element itself as a bare
 * `HTMLWebViewElement` — an empty interface — so none of the methods a
 * `<webview>` actually has are visible on a ref. Declared here rather than
 * imported from Electron's own `WebviewTag`, because that type lives in the
 * `electron` package and the renderer deliberately doesn't depend on it: it
 * reaches the main process only through `window.api`.
 */
export interface WebviewElement extends HTMLWebViewElement {
  src: string
  reload(): void
  getURL(): string
  executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>
}

/**
 * `did-fail-load`'s payload. A plain `Event` as far as the DOM is concerned —
 * Chromium hangs these extra fields off it, so they have to be declared to be
 * read.
 */
export interface WebviewFailLoadEvent extends Event {
  errorCode: number
  errorDescription: string
  validatedURL: string
  isMainFrame: boolean
}
