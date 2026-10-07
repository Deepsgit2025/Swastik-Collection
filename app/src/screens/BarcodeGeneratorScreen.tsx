import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { flushSync } from 'react-dom'
import { AppShell } from '../components/AppShell.tsx'
import { Label } from '../components/Label.tsx'
import { LabelPrintSheet } from '../components/LabelPrintSheet.tsx'
import type { QueuedLabelPrintItem } from '../components/LabelPrintSheet.tsx'
import { formatCurrency, formatDate } from '../lib/format.ts'
import type { BarcodeLabelRow } from '../types/barcodeLabel.ts'
import type { LabelSize } from '../types/settings.ts'
import { DEFAULT_LABEL_HEIGHT_MM, DEFAULT_LABEL_WIDTH_MM } from '../lib/labelLayout.ts'
import { useOwnerGate } from '../auth/useOwnerGate.tsx'

const MAX_QUANTITY = 500
const DEFAULT_LABEL_SIZE: LabelSize = { widthMm: DEFAULT_LABEL_WIDTH_MM, heightMm: DEFAULT_LABEL_HEIGHT_MM }

interface QueueEntry {
  key: string
  itemName: string
  price: number | null
  customCode: string | null
  quantity: number
  header: string | null
  line1: string | null
  line2: string | null
  line3: string | null
  line4: string | null
}

/**
 * Barcode generator screen (PHASE4.md section 2, extended per client
 * request). Both roles can generate labels per section 6, so RequireRole is
 * the only access gate for the generator/print flow itself. The one
 * role-conditional bit is the "Label Size Settings" panel below the preview
 * (`settings:edit` is Owner-only, same pattern as PartyListScreen's
 * Owner-only controls) — Salesman sees the current size read-only. The
 * useBarcodeScanner hook (section 5) is a separate PHASE4.md prompt and not
 * built here.
 *
 * Flow (reworked from a one-shot "Generate Label" to match the Vyapar
 * reference the client pointed at): fill the form and "Add for Barcode" to
 * queue an item locally (nothing saved to the DB yet), repeat for as many
 * items as needed, then "Generate" saves every queued item in one pass and
 * prints all of them — each repeated its own "No of Labels" times — in a
 * single spooled job. Printing uses window.print() — Chromium's native
 * print, which Electron backs with the OS print dialog — rather than a
 * main-process IPC call, since printing is a renderer-only concern with
 * nothing to authenticate or touch the DB for.
 */
export function BarcodeGeneratorScreen() {
  // Changing the label size affects every label printed afterwards, so saving
  // it asks for the Owner password (2026-09-19) - the form itself is open.
  const { run, gate } = useOwnerGate()

  const [labelSize, setLabelSize] = useState<LabelSize>(DEFAULT_LABEL_SIZE)
  const [labelSizeForm, setLabelSizeForm] = useState({
    width: String(DEFAULT_LABEL_SIZE.widthMm),
    height: String(DEFAULT_LABEL_SIZE.heightMm),
  })
  const [labelSizeError, setLabelSizeError] = useState<string | null>(null)
  const [labelSizeSaving, setLabelSizeSaving] = useState(false)
  const [labelSizeSaved, setLabelSizeSaved] = useState(false)

  useEffect(() => {
    let cancelled = false
    window.api
      .getLabelSize()
      .then((size) => {
        if (cancelled) return
        setLabelSize(size)
        setLabelSizeForm({ width: String(size.widthMm), height: String(size.heightMm) })
      })
      .catch(() => {
        // Keep the 50mm x 25mm default rather than blocking the whole screen on this.
      })
    return () => {
      cancelled = true
    }
  }, [])

  async function handleSaveLabelSize(event: FormEvent) {
    event.preventDefault()
    setLabelSizeError(null)
    setLabelSizeSaved(false)

    const widthMm = Number(labelSizeForm.width)
    const heightMm = Number(labelSizeForm.height)
    if (!Number.isFinite(widthMm) || !Number.isFinite(heightMm) || widthMm <= 0 || heightMm <= 0) {
      setLabelSizeError('Width and height must be positive numbers.')
      return
    }

    run({ title: 'Save label size', description: 'Changing the label size needs the Owner password.' }, async () => {
      setLabelSizeSaving(true)
      try {
        const saved = await window.api.setLabelSize({ widthMm, heightMm })
        setLabelSize(saved)
        setLabelSizeSaved(true)
      } catch (err) {
        setLabelSizeError(err instanceof Error && err.message ? err.message : 'Could not save the label size.')
      } finally {
        setLabelSizeSaving(false)
      }
    })
  }

  const [itemName, setItemName] = useState('')
  const [price, setPrice] = useState('')
  const [customCode, setCustomCode] = useState('')
  const [quantity, setQuantity] = useState('1')
  const [header, setHeader] = useState('')
  const [line1, setLine1] = useState('')
  const [line2, setLine2] = useState('')
  const [line3, setLine3] = useState('')
  const [line4, setLine4] = useState('')
  const [formError, setFormError] = useState<string | null>(null)

  const [queue, setQueue] = useState<QueueEntry[]>([])
  const [generating, setGenerating] = useState(false)
  const [generateError, setGenerateError] = useState<string | null>(null)
  const [printItems, setPrintItems] = useState<QueuedLabelPrintItem[]>([])

  const [labels, setLabels] = useState<BarcodeLabelRow[]>([])
  const [labelsLoading, setLabelsLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [refreshCount, setRefreshCount] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLabelsLoading(true)

    window.api
      .getBarcodeLabels({ search })
      .then((rows) => {
        if (!cancelled) setLabels(rows)
      })
      .catch(() => {
        // Label history is secondary to the generator form — fail quietly and leave the list empty rather than blocking the form with an error.
        if (!cancelled) setLabels([])
      })
      .finally(() => {
        if (!cancelled) setLabelsLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [search, refreshCount])

  function refresh() {
    setRefreshCount((count) => count + 1)
  }

  function resetForm() {
    setItemName('')
    setPrice('')
    setCustomCode('')
    setQuantity('1')
    setHeader('')
    setLine1('')
    setLine2('')
    setLine3('')
    setLine4('')
  }

  function handleAddToQueue(event: FormEvent) {
    event.preventDefault()
    setFormError(null)

    const name = itemName.trim()
    if (!name) {
      setFormError('Item name is required.')
      return
    }

    if (price.trim() && (Number.isNaN(Number(price)) || Number(price) < 0)) {
      setFormError('Price must be a non-negative number.')
      return
    }

    const parsedQuantity = Number(quantity)
    if (!Number.isInteger(parsedQuantity) || parsedQuantity < 1 || parsedQuantity > MAX_QUANTITY) {
      setFormError(`No of Labels must be a whole number between 1 and ${MAX_QUANTITY}.`)
      return
    }

    const trimmedCode = customCode.trim() || null
    if (trimmedCode && queue.some((entry) => entry.customCode === trimmedCode)) {
      setFormError(`The code "${trimmedCode}" is already queued for another item in this batch.`)
      return
    }

    setQueue((current) => [
      ...current,
      {
        key: crypto.randomUUID(),
        itemName: name,
        price: price.trim() ? Number(price) : null,
        customCode: trimmedCode,
        quantity: parsedQuantity,
        header: header.trim() || null,
        line1: line1.trim() || null,
        line2: line2.trim() || null,
        line3: line3.trim() || null,
        line4: line4.trim() || null,
      },
    ])
    resetForm()
  }

  function removeFromQueue(key: string) {
    setQueue((current) => current.filter((entry) => entry.key !== key))
  }

  /**
   * Saves every queued item to `barcode_labels`, then prints the whole batch
   * (each item repeated its own quantity) in one job. If an item fails
   * (e.g. a reused custom code), the loop stops there — items already saved
   * are removed from the queue and still get printed, since they're real
   * saved rows now; the failing item and anything after it stay queued for
   * the user to fix and retry.
   */
  async function handleGenerate() {
    if (queue.length === 0) return
    setGenerateError(null)
    setGenerating(true)

    const succeeded: QueuedLabelPrintItem[] = []
    let remaining = queue

    for (const entry of queue) {
      try {
        const label = await window.api.createBarcodeLabel({
          itemName: entry.itemName,
          price: entry.price,
          customCode: entry.customCode,
          header: entry.header,
          line1: entry.line1,
          line2: entry.line2,
          line3: entry.line3,
          line4: entry.line4,
        })
        succeeded.push({ label, copies: entry.quantity })
        remaining = remaining.filter((item) => item.key !== entry.key)
      } catch (err) {
        const message = err instanceof Error && err.message ? err.message : 'Could not generate this label.'
        setGenerateError(`"${entry.itemName}": ${message}`)
        break
      }
    }

    setGenerating(false)
    setQueue(remaining)

    if (succeeded.length > 0) {
      flushSync(() => setPrintItems(succeeded))
      // Printing goes through the main process: Electron ships no
      // print-preview UI, so a renderer-side window.print() only opens a dead
      // "This app doesn't support print preview" window instead of reaching
      // the printer. flushSync above still matters — the label sheet has to
      // be in the DOM before the main process prints the page.
      try {
        await window.api.printPage()
      } catch (err) {
        const message = err instanceof Error ? err.message : ''
        if (!message.includes('PRINT_CANCELLED')) {
          setGenerateError(message || 'Could not print these labels. Please try again.')
        }
      }
      refresh()
    }
  }

  const previewPrice = price.trim() ? Number(price) : null
  const previewValid = itemName.trim() && !Number.isNaN(previewPrice ?? 0)

  return (
    <AppShell>
      <div className="flex flex-1 flex-col gap-6 p-6">
        <h1 className="text-xl font-semibold text-slate-800">Barcode Generator</h1>

        <div className="flex flex-col gap-6 lg:flex-row">
          <form
            onSubmit={handleAddToQueue}
            className="grid w-full grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-6 sm:grid-cols-2 lg:max-w-2xl"
          >
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Item name
              <input
                autoFocus
                type="text"
                value={itemName}
                onChange={(event) => setItemName(event.target.value)}
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Price
              <input
                type="number"
                step="0.01"
                min="0"
                value={price}
                onChange={(event) => setPrice(event.target.value)}
                placeholder="0"
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Custom code (optional)
              <input
                type="text"
                value={customCode}
                onChange={(event) => setCustomCode(event.target.value)}
                placeholder="Leave blank to auto-generate"
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              No of Labels
              <input
                type="number"
                min="1"
                max={MAX_QUANTITY}
                value={quantity}
                onChange={(event) => setQuantity(event.target.value)}
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600 sm:col-span-2">
              Header (optional)
              <input
                type="text"
                value={header}
                onChange={(event) => setHeader(event.target.value)}
                placeholder="e.g. shop name"
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Line 1 (optional)
              <input
                type="text"
                value={line1}
                onChange={(event) => setLine1(event.target.value)}
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Line 2 (optional)
              <input
                type="text"
                value={line2}
                onChange={(event) => setLine2(event.target.value)}
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Line 3 (optional)
              <input
                type="text"
                value={line3}
                onChange={(event) => setLine3(event.target.value)}
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>

            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Line 4 (optional)
              <input
                type="text"
                value={line4}
                onChange={(event) => setLine4(event.target.value)}
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>

            {formError && (
              <p role="alert" className="text-sm text-red-600 sm:col-span-2">
                {formError}
              </p>
            )}

            <button
              type="submit"
              className="mt-2 rounded bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700 sm:col-span-2"
            >
              Add for Barcode
            </button>
          </form>

          <div className="flex w-full max-w-xs flex-col gap-2 rounded-lg border border-slate-200 bg-white p-6">
            <h2 className="text-sm font-medium text-slate-600">Preview</h2>
            {previewValid ? (
              <div className="flex justify-center rounded border border-dashed border-slate-300 p-2">
                <Label
                  itemName={itemName.trim()}
                  price={previewPrice}
                  barcodeValue={customCode.trim() || 'PREVIEW'}
                  header={header.trim() || null}
                  line1={line1.trim() || null}
                  line2={line2.trim() || null}
                  line3={line3.trim() || null}
                  line4={line4.trim() || null}
                  widthMm={labelSize.widthMm}
                  heightMm={labelSize.heightMm}
                />
              </div>
            ) : (
              <p className="text-sm text-slate-500">Fill in the item name to see its tag here.</p>
            )}

            <div className="mt-4 border-t border-slate-100 pt-4">
              <h2 className="text-sm font-medium text-slate-600">Label Size Settings</h2>
              <form onSubmit={handleSaveLabelSize} className="mt-2 flex flex-col gap-2">
                <div className="flex gap-2">
                  <label className="flex flex-1 flex-col gap-1 text-xs text-slate-600">
                    Width (mm)
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={labelSizeForm.width}
                      onChange={(event) => setLabelSizeForm((form) => ({ ...form, width: event.target.value }))}
                      className="rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
                    />
                  </label>
                  <label className="flex flex-1 flex-col gap-1 text-xs text-slate-600">
                    Height (mm)
                    <input
                      type="number"
                      step="0.1"
                      min="0"
                      value={labelSizeForm.height}
                      onChange={(event) => setLabelSizeForm((form) => ({ ...form, height: event.target.value }))}
                      className="rounded border border-slate-300 px-2 py-1.5 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
                    />
                  </label>
                </div>

                {labelSizeError && (
                  <p role="alert" className="text-xs text-red-600">
                    {labelSizeError}
                  </p>
                )}
                {labelSizeSaved && !labelSizeError && <p className="text-xs text-green-600">Saved.</p>}

                <button
                  type="submit"
                  disabled={labelSizeSaving}
                  className="rounded bg-slate-800 px-3 py-1.5 text-xs text-white hover:bg-slate-700 disabled:opacity-50"
                >
                  {labelSizeSaving ? 'Saving…' : 'Save Label Size'}
                </button>
              </form>
              {gate}
            </div>
          </div>
        </div>

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-800">Item List</h2>
            <button
              type="button"
              onClick={handleGenerate}
              disabled={queue.length === 0 || generating}
              className="rounded bg-slate-800 px-4 py-2 text-sm text-white hover:bg-slate-700 disabled:opacity-50"
            >
              {generating ? 'Generating…' : 'Generate'}
            </button>
          </div>

          {generateError && (
            <p role="alert" className="mb-3 text-sm text-red-600">
              {generateError}
            </p>
          )}

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">No of Labels</th>
                  <th className="px-4 py-2 font-medium">Header</th>
                  <th className="px-4 py-2 font-medium">Line 1</th>
                  <th className="px-4 py-2 font-medium">Line 2</th>
                  <th className="px-4 py-2 font-medium">Line 3</th>
                  <th className="px-4 py-2 font-medium">Line 4</th>
                  <th className="px-4 py-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {queue.map((entry) => (
                  <tr key={entry.key} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-slate-800">{entry.itemName}</td>
                    <td className="px-4 py-2 text-slate-600">{entry.quantity}</td>
                    <td className="px-4 py-2 text-slate-600">{entry.header ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{entry.line1 ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{entry.line2 ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{entry.line3 ?? '—'}</td>
                    <td className="px-4 py-2 text-slate-600">{entry.line4 ?? '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeFromQueue(entry.key)}
                        className="text-slate-400 hover:text-red-600"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
                {queue.length === 0 && (
                  <tr>
                    <td colSpan={8} className="px-4 py-6 text-center text-slate-500">
                      Added items for barcode generation will appear here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <LabelPrintSheet items={printItems} labelSize={labelSize} />

        <div>
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-slate-800">Label History</h2>
            <input
              type="text"
              placeholder="Search by item name or code"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="w-72 rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
          </div>

          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-4 py-2 font-medium">Item</th>
                  <th className="px-4 py-2 font-medium">Price</th>
                  <th className="px-4 py-2 font-medium">Code</th>
                  <th className="px-4 py-2 font-medium">Created</th>
                </tr>
              </thead>
              <tbody>
                {labels.map((label) => (
                  <tr key={label.id} className="border-t border-slate-100">
                    <td className="px-4 py-2 text-slate-800">{label.item_name}</td>
                    <td className="px-4 py-2 text-slate-600">
                      {label.price != null ? formatCurrency(label.price) : '—'}
                    </td>
                    <td className="px-4 py-2 font-mono text-slate-600">{label.barcode_value}</td>
                    <td className="px-4 py-2 text-slate-500">{formatDate(label.created_at)}</td>
                  </tr>
                ))}
                {!labelsLoading && labels.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-slate-500">
                      No labels generated yet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </AppShell>
  )
}
