import electron from 'electron'

const { BrowserWindow } = electron

const RENDER_WIDTH = 480

/**
 * Renders a standalone HTML document (from src/lib/billImage.ts's
 * buildBillImageHtml) to a PNG buffer, using a hidden BrowserWindow as a
 * one-shot screenshot tool. This is Electron's own bundled Chromium — fully
 * separate from whatsapp-web.js's own Puppeteer-driven Chrome instance in
 * client.ts, so no new dependency and no electron-builder.yml change needed.
 *
 * Deliberately NOT `webPreferences: { offscreen: true }` — Electron's
 * offscreen mode delivers frames via the 'paint' event, a different pipeline
 * from `capturePage()`; mixing the two was the cause of real intermittent
 * failures in production (every failed send in whatsapp_log was paired —
 * owner and customer failing together for the same sale — which is the
 * signature of this render step throwing before either WhatsApp send was
 * even attempted). A plain hidden window (`show: false`) is what
 * `capturePage()` is documented and designed for; `{ stayHidden: true }`
 * tells Electron to properly activate the page's renderer for capture
 * without briefly flashing the window on screen.
 *
 * No direct test — same convention client.ts already follows, since this
 * needs a real Electron process; src/lib/billImage.test.ts covers the HTML
 * content this function is handed.
 */
export async function renderBillImagePng(html: string): Promise<Buffer> {
  const win = new BrowserWindow({
    show: false,
    width: RENDER_WIDTH,
    height: 600,
  })

  try {
    await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    const contentHeight = (await win.webContents.executeJavaScript(
      'Math.ceil(document.documentElement.getBoundingClientRect().height)',
    )) as number

    win.setContentSize(RENDER_WIDTH, Math.max(contentHeight, 1))

    // The resize above triggers a layout+paint that hasn't necessarily
    // finished by the time capturePage would otherwise run — waiting two
    // animation frames (a standard "the browser has definitely painted by
    // now" signal) avoids racing capturePage against that in-flight repaint.
    await win.webContents.executeJavaScript(
      'new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))',
    )

    const image = await win.webContents.capturePage(undefined, { stayHidden: true })
    return image.toPNG()
  } catch (err) {
    console.error('[billImage] renderBillImagePng failed:', err)
    throw err
  } finally {
    win.destroy()
  }
}
