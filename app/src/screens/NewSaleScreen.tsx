import { useEffect, useMemo, useRef, useState } from 'react'
import { AppShell } from '../components/AppShell.tsx'
import { BillPrintSheet } from '../components/BillPrintSheet.tsx'
import { useAuth } from '../auth/AuthContext.tsx'
import { OwnerPasswordPrompt } from '../auth/OwnerPasswordPrompt.tsx'
import { useBarcodeScanner } from '../hooks/useBarcodeScanner.ts'
import { computeSaleTotals, validateDiscount, validateLine, validateSplitTotal } from '../lib/saleMath.ts'
import { formatCurrency } from '../lib/format.ts'
import { isBillDeliveryConfirmed } from '../lib/printGate.ts'
import type { BarcodeLabelRow } from '../types/barcodeLabel.ts'
import type { PartyListRow } from '../types/party.ts'
import type { SalesmanRow } from '../types/salesman.ts'
import type { PaymentMode, SaleRecord } from '../types/sale.ts'

/**
 * `unitPrice` is nullable **here and only here**: null means "nobody has typed
 * a price yet", which renders as an empty box with the cursor in it rather
 * than a pre-filled `0`. A pre-filled zero reads as already-answered and gets
 * tabbed past, and the bill goes out at ₹0.
 *
 * `lib/saleMath.ts` and `SaleItemInput` keep `unitPrice: number` — the
 * blankness never leaves this screen. `handleCompleteSale` refuses a line
 * still sitting at null before anything is sent to `createSale`, so an
 * explicitly typed 0 (a genuinely free item) stays legal while an untouched
 * box does not.
 */
interface CartLine {
  key: string
  itemName: string
  barcode: string | null
  quantity: number
  unitPrice: number | null
}

function newLine(itemName: string, unitPrice: number | null, barcode: string | null = null): CartLine {
  return { key: crypto.randomUUID(), itemName, barcode, quantity: 1, unitPrice }
}

/** How many saved items the search dropdown asks for. A screenful and a bit — enough to scroll, not enough to make an unfiltered open slow once the shop has thousands of labels. */
const ITEM_DROPDOWN_LIMIT = 50

/**
 * Sale creation screen (PHASE5.md section 1, `/sale/new`), styled after the
 * client's Vyapar-style reference: a single scan/search bar over a
 * spreadsheet-like item grid, and a right-hand panel for customer/payment.
 * Discount is a single bill-level field (not a per-line column) — see the
 * note on `CreateSaleInput` in types/sale.ts for why this differs from the
 * original Phase 5 spec. Saves via `createSale`, which triggers Phase 6's
 * WhatsApp sends server-side. The Print button used to be gated on the
 * resulting `whatsapp_customer_sent`/`whatsapp_owner_sent` flags; as of
 * 2026-08-24 it is not, because a resyncing WhatsApp session was stopping the
 * counter with a customer stood waiting. Delivery is queued and retried
 * automatically instead, and this panel reports where each bill has got to —
 * see `isBillDeliveryConfirmed` (src/lib/printGate.ts) for what that traded
 * away.
 */
export function NewSaleScreen() {
  const { lock } = useAuth()
  const [cart, setCart] = useState<CartLine[]>([])
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const qtyInputRefs = useRef(new Map<string, HTMLInputElement>())
  const priceInputRefs = useRef(new Map<string, HTMLInputElement>())
  /** Set when a line is added with no price, so the effect below can put the cursor in its price box once it has rendered. */
  const [focusPriceKey, setFocusPriceKey] = useState<string | null>(null)

  const [itemSearch, setItemSearch] = useState('')
  const [itemResults, setItemResults] = useState<BarcodeLabelRow[]>([])
  const [itemFieldFocused, setItemFieldFocused] = useState(false)
  const [highlightIndex, setHighlightIndex] = useState(-1)
  const [scanMessage, setScanMessage] = useState<{ kind: 'error' | 'ok'; text: string } | null>(null)

  const [salesmen, setSalesmen] = useState<SalesmanRow[]>([])
  // Kept across sales on purpose. One person usually works a whole shift, and
  // re-picking on every bill is the kind of friction that gets skipped — which
  // would leave the Owner with exactly the gaps this field exists to close.
  // Optional by client decision, so '' (Unassigned) is a legal resting state.
  // Free text with suggestions (2026-09-19): a name that is not in the list yet
  // is added as a new salesman when the sale is saved.
  const [salesmanName, setSalesmanName] = useState<string>('')

  const [selectedParty, setSelectedParty] = useState<PartyListRow | null>(null)
  const [customerName, setCustomerName] = useState('')
  const [customerPhone, setCustomerPhone] = useState('')
  const [partyResults, setPartyResults] = useState<PartyListRow[]>([])

  // Blank, not '0', for the same reason the price box above is: a zero sitting
  // in the field looks like a decision someone made. Empty parses to 0 anyway
  // (`Number('') || 0`), so no total changes — only what the operator sees.
  const [discountInput, setDiscountInput] = useState('')
  const [showBreakup, setShowBreakup] = useState(false)

  const [paymentMode, setPaymentMode] = useState<PaymentMode>('cash')
  const [splitCash, setSplitCash] = useState(0)
  const [splitUpi, setSplitUpi] = useState(0)
  const [splitCredit, setSplitCredit] = useState(0)
  const [amountReceived, setAmountReceived] = useState('')

  const [formError, setFormError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedSale, setSavedSale] = useState<SaleRecord | null>(null)
  const [savedSalePartyName, setSavedSalePartyName] = useState<string | null>(null)

  const [printing, setPrinting] = useState(false)
  const [overriding, setOverriding] = useState(false)
  /** True while the Owner password prompt for the override is on screen. */
  const [askingOverride, setAskingOverride] = useState(false)
  const [printError, setPrintError] = useState<string | null>(null)

  const discount = Number(discountInput) || 0
  // An unpriced line counts as 0 towards the running total rather than making
  // it NaN — the operator still sees the bill build up as they type, and
  // `handleCompleteSale` is what refuses to save it.
  const totals = useMemo(
    () => computeSaleTotals(cart.map((line) => ({ ...line, unitPrice: line.unitPrice ?? 0 })), discount),
    [cart, discount],
  )
  const totalQuantity = cart.reduce((sum, line) => sum + line.quantity, 0)
  // Focus alone opens it — that is the point of the change. Even with an empty
  // catalogue the panel renders, carrying the "no saved items yet" hint, so
  // clicking the box always answers the question the operator asked by
  // clicking it.
  const itemDropdownOpen = itemFieldFocused

  const { cashAmount, upiAmount, creditAmount } =
    paymentMode === 'cash'
      ? { cashAmount: totals.grandTotal, upiAmount: 0, creditAmount: 0 }
      : paymentMode === 'upi'
        ? { cashAmount: 0, upiAmount: totals.grandTotal, creditAmount: 0 }
        : paymentMode === 'credit'
          ? { cashAmount: 0, upiAmount: 0, creditAmount: totals.grandTotal }
          : { cashAmount: splitCash, upiAmount: splitUpi, creditAmount: splitCredit }

  const partyRequired = creditAmount > 0
  // A party is "on file" for this sale either because an existing customer was
  // picked from the suggestions dropdown, or because both fields were typed in
  // directly for a brand-new customer — resolved into a real party record via
  // quickAddParty at save time (handleCompleteSale below).
  const hasNewPartyInfo = !selectedParty && customerName.trim() !== '' && customerPhone.trim() !== ''
  const hasPartyInfo = selectedParty != null || hasNewPartyInfo
  const cashPortion = paymentMode === 'split' ? splitCash : paymentMode === 'cash' ? totals.grandTotal : 0
  const changeToReturn = cashPortion > 0 ? Math.max(0, (Number(amountReceived) || 0) - cashPortion) : 0

  // Item search (PHASE5.md section 1: "manual item search/add by name" for
  // items without a generated barcode). Searches the same label catalog the
  // barcode scanner matches against — Phase 4's `barcode_labels` — since this
  // app has no separate items table (no stock/inventory tracking, ever).
  //
  // An **empty** term is no longer a no-op: it fetches the most recent labels
  // so that simply clicking into the box drops down the saved item names to
  // pick from, rather than showing nothing until enough has been typed to
  // guess a match. `limit` is what keeps that unbounded query honest.
  useEffect(() => {
    let cancelled = false
    const term = itemSearch.trim()
    window.api
      .getBarcodeLabels(term ? { search: term, limit: ITEM_DROPDOWN_LIMIT } : { limit: ITEM_DROPDOWN_LIMIT })
      .then((rows) => {
        if (!cancelled) setItemResults(rows)
      })
      .catch(() => {
        if (!cancelled) setItemResults([])
      })
    return () => {
      cancelled = true
    }
  }, [itemSearch])

  // Any change to the term invalidates whatever row was highlighted — index 2
  // of the old result set is a different item in the new one.
  useEffect(() => {
    setHighlightIndex(-1)
  }, [itemSearch])

  // The suggestions for the salesman box. Active salesmen only — a retired one
  // must not be offered on a new bill, though their name still resolves on
  // every old one. `salesmenVersion` bumps after a sale is saved so a name typed
  // for the first time shows up as a suggestion on the very next bill.
  const [salesmenVersion, setSalesmenVersion] = useState(0)
  useEffect(() => {
    let cancelled = false
    window.api
      .getSalesmen({ activeOnly: true })
      .then((rows) => {
        if (!cancelled) setSalesmen(rows)
      })
      .catch(() => {
        if (!cancelled) setSalesmen([])
      })
    return () => {
      cancelled = true
    }
  }, [salesmenVersion])

  // Puts the cursor in the price box of a line that arrived without one. Has to
  // wait for the row to render, hence an effect keyed on the pending line
  // rather than a call inside the add handler.
  useEffect(() => {
    if (!focusPriceKey) return
    priceInputRefs.current.get(focusPriceKey)?.focus()
    setFocusPriceKey(null)
  }, [focusPriceKey])

  // Customer-name suggestions (search-as-you-type). Stops searching once a
  // suggestion has been picked — `selectedParty` is cleared again the moment
  // the name field is edited by hand, via handleCustomerNameChange below.
  useEffect(() => {
    let cancelled = false
    const term = customerName.trim()
    if (!term || selectedParty) {
      setPartyResults([])
      return
    }
    window.api
      .getParties({ search: term })
      .then((rows) => {
        if (!cancelled) setPartyResults(rows)
      })
      .catch(() => {
        if (!cancelled) setPartyResults([])
      })
    return () => {
      cancelled = true
    }
  }, [customerName, selectedParty])

  /** A label with no saved price adds an *unpriced* line (null, not 0) and takes the cursor straight to the price box — the operator has to type one. */
  function addLineFromLabel(label: BarcodeLabelRow) {
    const line = newLine(label.item_name, label.price ?? null, label.barcode_value)
    setCart((current) => [...current, line])
    setSelectedKey(line.key)
    if (line.unitPrice == null) setFocusPriceKey(line.key)
    setSavedSale(null)
  }

  /** An item typed in by hand has no saved price at all, so it always lands unpriced with the cursor waiting in the price box. */
  function addManualLine() {
    const name = itemSearch.trim()
    if (!name) return
    const line = newLine(name, null)
    setCart((current) => [...current, line])
    setSelectedKey(line.key)
    setFocusPriceKey(line.key)
    setItemSearch('')
    setItemFieldFocused(false)
    setSavedSale(null)
  }

  function updateLine(key: string, patch: Partial<Pick<CartLine, 'quantity' | 'unitPrice'>>) {
    setCart((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)))
  }

  /** Shared by every path that puts an item in the cart from the search box, so picking with the mouse, with Enter, and with the arrow keys all leave the box in the same state. */
  function pickLabel(label: BarcodeLabelRow) {
    addLineFromLabel(label)
    setItemSearch('')
    setItemFieldFocused(false)
  }

  function removeLine(key: string) {
    setCart((current) => current.filter((line) => line.key !== key))
    setSelectedKey((current) => (current === key ? null : current))
  }

  function handleScan(code: string) {
    const trimmed = code.trim()
    if (!trimmed) return
    window.api
      .getBarcodeLabels({ search: trimmed })
      .then((rows) => {
        const match = rows.find((row) => row.barcode_value === trimmed)
        if (match) {
          addLineFromLabel(match)
          setScanMessage({ kind: 'ok', text: `Added "${match.item_name}" from scan.` })
        } else {
          setScanMessage({ kind: 'error', text: `No item found for barcode "${trimmed}".` })
        }
      })
      .catch(() => {
        setScanMessage({ kind: 'error', text: 'Could not look up that barcode. Please try again.' })
      })
  }

  // Global scanner listener (Phase 4's hook — fires on a fast keystroke burst
  // ending in Enter/Tab, from anywhere on the page, not just this input).
  useBarcodeScanner((code) => handleScan(code))

  // Keyboard shortcuts for the row action bar, matching the reference UI's
  // [F2]/[F4] labels. Function-key presses are single events, not character
  // bursts, so they never interact with the barcode scanner hook above.
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!selectedKey) return
      if (event.key === 'F2') {
        event.preventDefault()
        qtyInputRefs.current.get(selectedKey)?.focus()
      } else if (event.key === 'F4') {
        event.preventDefault()
        removeLine(selectedKey)
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [selectedKey])

  /** Typing in the Customer Name field always deselects any previously picked party — the fields go back to being free text for a new/different customer until a suggestion is clicked again. */
  function handleCustomerNameChange(value: string) {
    setCustomerName(value)
    if (selectedParty) setSelectedParty(null)
  }

  /** A suggestion click autofills the phone number from the matched party's saved record. */
  function handlePartySelect(row: PartyListRow) {
    setSelectedParty(row)
    setCustomerName(row.name)
    setCustomerPhone(row.phone ?? '')
    setPartyResults([])
  }

  function handleUseWalkIn() {
    setSelectedParty(null)
    setCustomerName('')
    setCustomerPhone('')
  }

  async function handleCompleteSale() {
    setFormError(null)
    setSavedSale(null)
    setSavedSalePartyName(null)
    setPrintError(null)

    if (cart.length === 0) {
      setFormError('Add at least one item to the cart.')
      return
    }

    // Checked before `validateLine`, which takes a plain number and so cannot
    // tell an untouched box from a deliberate ₹0. This is the whole point of
    // `CartLine.unitPrice` being nullable — an unpriced line is stopped here
    // rather than quietly billed at zero.
    for (const line of cart) {
      if (line.unitPrice == null) {
        setFormError(`Enter a price for "${line.itemName.trim() || 'this item'}".`)
        priceInputRefs.current.get(line.key)?.focus()
        return
      }
    }

    for (const line of cart) {
      const error = validateLine({ ...line, unitPrice: line.unitPrice ?? 0 })
      if (error) {
        setFormError(error)
        return
      }
    }

    const discountError = validateDiscount(discount, totals.subtotal)
    if (discountError) {
      setFormError(discountError)
      return
    }

    const splitError = validateSplitTotal(cashAmount, upiAmount, creditAmount, totals.grandTotal)
    if (splitError) {
      setFormError(splitError)
      return
    }

    // Partial customer info can't resolve to a real party record — quickAddParty
    // requires both fields, so catch this early with a clear message rather
    // than letting a name-only or phone-only entry surface as a raw API error.
    if (!selectedParty && customerName.trim() !== '' && customerPhone.trim() === '') {
      setFormError('Enter a mobile number to save this customer, or clear the name for a Walk-in sale.')
      return
    }
    if (!selectedParty && customerName.trim() === '' && customerPhone.trim() !== '') {
      setFormError('Enter a customer name to save this customer, or clear the mobile number for a Walk-in sale.')
      return
    }

    if (partyRequired && !hasPartyInfo) {
      setFormError('A party is required for a credit sale, or a split sale with a credit component.')
      return
    }

    setSaving(true)
    try {
      let partyId: number | null = selectedParty?.id ?? null
      if (hasNewPartyInfo) {
        const created = await window.api.quickAddParty({ name: customerName.trim(), phone: customerPhone.trim() })
        partyId = created.id
      }

      const sale = await window.api.createSale({
        partyId,
        // Blank is Unassigned, which is a real choice rather than a missing
        // value — `createSale` accepts null and reports it as such. A name that
        // is not in the list yet is added by `createSale` itself.
        salesmanName: salesmanName.trim() === '' ? null : salesmanName.trim(),
        items: cart.map((line) => ({
          itemName: line.itemName,
          barcode: line.barcode,
          quantity: line.quantity,
          // Never actually null by here — the loop above returns on the first
          // unpriced line — but the coalesce keeps this honest against the type
          // rather than asserting past it.
          unitPrice: line.unitPrice ?? 0,
        })),
        discount,
        paymentMode,
        cashAmount,
        upiAmount,
        creditAmount,
      })
      setSavedSale(sale)
      // A salesman typed for the first time now exists — refresh the suggestions.
      setSalesmenVersion((version) => version + 1)
      // Captured before the customer fields reset below — the bill still
      // needs this name even after the form goes back to a blank Walk-in
      // state for the next sale.
      setSavedSalePartyName(selectedParty?.name ?? (hasNewPartyInfo ? customerName.trim() : null))
      setCart([])
      setSelectedKey(null)
      setSelectedParty(null)
      setCustomerName('')
      setCustomerPhone('')
      setDiscountInput('')
      setPaymentMode('cash')
      setSplitCash(0)
      setSplitUpi(0)
      setSplitCredit(0)
      setAmountReceived('')
    } catch (err) {
      setFormError(err instanceof Error && err.message ? err.message : 'Could not save this sale. Please try again.')
    } finally {
      setSaving(false)
    }
  }

  /**
   * PHASE7.md section 2: clicking Print renders the bill layout and sends it
   * to the printer, then sets `sales.printed = true`. `printSale` still
   * re-checks the caller's `sale:print` permission server-side; what it no
   * longer re-checks is WhatsApp delivery.
   *
   * `printSale` does the printing too, from the main process: Electron ships
   * no print-preview UI, so a renderer-side `window.print()` only opens a
   * dead "This app doesn't support print preview" window. It resolves with
   * the updated sale once the printer has accepted the job, and rejects if
   * the operator cancels — in which case the bill stays unprinted and the
   * button stays available for another go.
   */
  async function handlePrint() {
    if (!savedSale || printing) return
    setPrintError(null)
    setPrinting(true)
    try {
      const updated = await window.api.printSale(savedSale.id)
      setSavedSale(updated)
    } catch (err) {
      const message = err instanceof Error ? err.message : ''
      setPrintError(
        message.includes('PRINT_CANCELLED')
          ? 'Print cancelled — this bill has not been printed yet.'
          : message || 'Could not print this bill. Please try again.',
      )
    } finally {
      setPrinting(false)
    }
  }

  /**
   * Owner-only override (PHASE6.md section 3), run straight after the password
   * prompt has elevated this window.
   *
   * `usePrintOverride`'s own `assertPermission(role, 'sale:print_override')` is
   * still the real enforcement — the prompt is how an Owner asks, not what
   * decides. **The `lock()` in the `finally` is load-bearing**: this is an
   * Owner action on a screen that is otherwise open at the counter, so leaving
   * the window elevated afterwards would hand whoever is standing there the
   * run of the app. It locks whether the call succeeded or failed.
   */
  async function handleOverride() {
    if (!savedSale || overriding) return
    setPrintError(null)
    setOverriding(true)
    try {
      const updated = await window.api.usePrintOverride(savedSale.id)
      setSavedSale(updated)
    } catch (err) {
      setPrintError(err instanceof Error && err.message ? err.message : 'Could not use the print override. Please try again.')
    } finally {
      setOverriding(false)
      setAskingOverride(false)
      await lock()
    }
  }

  return (
    <AppShell>
      <div className="flex flex-1 overflow-hidden">
        {/* Item entry + grid */}
        <div className="flex flex-1 flex-col overflow-hidden p-4">
          <div className="relative mb-3">
            <input
              type="text"
              autoFocus
              value={itemSearch}
              role="combobox"
              aria-expanded={itemDropdownOpen}
              aria-controls="item-suggestions"
              aria-label="Scan or search by barcode, item name"
              onChange={(event) => setItemSearch(event.target.value)}
              onFocus={() => setItemFieldFocused(true)}
              // The list's buttons cancel their own mousedown (below), so a
              // blur here always means focus really left the control.
              onBlur={() => setItemFieldFocused(false)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                  if (itemResults.length === 0) return
                  event.preventDefault()
                  setItemFieldFocused(true)
                  setHighlightIndex((current) => {
                    const step = event.key === 'ArrowDown' ? 1 : -1
                    // Wraps in both directions, and an ArrowUp from "nothing
                    // highlighted" lands on the last row rather than doing
                    // nothing — the ordinary behaviour of a combobox list.
                    const next = current + step
                    if (next < 0) return itemResults.length - 1
                    if (next >= itemResults.length) return 0
                    return next
                  })
                } else if (event.key === 'Escape') {
                  setItemFieldFocused(false)
                  setHighlightIndex(-1)
                } else if (event.key === 'Enter') {
                  event.preventDefault()
                  const highlighted = highlightIndex >= 0 ? itemResults[highlightIndex] : undefined
                  const exact = itemResults.find((row) => row.item_name.toLowerCase() === itemSearch.trim().toLowerCase())
                  // An arrow-key selection wins over the exact-name match:
                  // whatever is visibly highlighted is what Enter should take.
                  if (highlighted) {
                    pickLabel(highlighted)
                  } else if (exact) {
                    pickLabel(exact)
                  } else if (itemResults.length === 0 && itemSearch.trim()) {
                    // Falls back to a direct barcode lookup — covers typing a
                    // code manually when the scanner burst isn't detected.
                    handleScan(itemSearch.trim())
                    setItemSearch('')
                  }
                }
              }}
              placeholder="Scan or search by barcode, item name"
              className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
            />
            {/*
              Open on focus, not only once something has been typed: clicking
              into the box is how the operator sees which items are already
              saved. With nothing typed the effect above has loaded the most
              recent labels, so there is always something to show.
            */}
            {itemDropdownOpen && (
              <ul
                id="item-suggestions"
                role="listbox"
                className="absolute z-10 mt-1 max-h-64 w-full overflow-auto rounded border border-slate-200 bg-white shadow-lg"
              >
                {itemResults.map((label, index) => (
                  <li key={label.id}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === highlightIndex}
                      // Without this the input blurs before the click lands and
                      // the list is already gone by the time it would fire.
                      onMouseDown={(event) => event.preventDefault()}
                      onMouseEnter={() => setHighlightIndex(index)}
                      onClick={() => pickLabel(label)}
                      className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-700 ${
                        index === highlightIndex ? 'bg-slate-100' : 'hover:bg-slate-100'
                      }`}
                    >
                      <span>{label.item_name}</span>
                      <span className="text-slate-400">{label.price != null ? formatCurrency(label.price) : '—'}</span>
                    </button>
                  </li>
                ))}
                {itemResults.length === 0 && !itemSearch.trim() && (
                  <li className="px-3 py-2 text-sm text-slate-400">
                    No saved items yet — type a name to add one.
                  </li>
                )}
                {/* Only offers to create what has actually been typed; an empty box has no name to add. */}
                {itemSearch.trim() !== '' && (
                  <li>
                    <button
                      type="button"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={addManualLine}
                      className="flex w-full items-center gap-1 border-t border-slate-100 px-3 py-2 text-left text-sm text-slate-600 hover:bg-slate-100"
                    >
                      + Add "{itemSearch.trim()}" as a new item
                    </button>
                  </li>
                )}
              </ul>
            )}
          </div>

          {scanMessage && (
            <p role="alert" className={`mb-2 text-sm ${scanMessage.kind === 'error' ? 'text-red-600' : 'text-emerald-600'}`}>
              {scanMessage.text}
            </p>
          )}

          <div className="flex-1 overflow-auto rounded-lg border border-slate-200 bg-white">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 font-medium">#</th>
                  <th className="px-3 py-2 font-medium">Item Code</th>
                  <th className="px-3 py-2 font-medium">Item Name</th>
                  <th className="px-3 py-2 font-medium">Qty</th>
                  <th className="px-3 py-2 font-medium">Price/Unit (₹)</th>
                  <th className="px-3 py-2 font-medium">Total (₹)</th>
                </tr>
              </thead>
              <tbody>
                {cart.map((line, index) => (
                  <tr
                    key={line.key}
                    onClick={() => setSelectedKey(line.key)}
                    className={`cursor-pointer border-t border-slate-100 ${selectedKey === line.key ? 'bg-blue-50' : 'hover:bg-slate-50'}`}
                  >
                    <td className="px-3 py-2 text-slate-500">{index + 1}</td>
                    <td className="px-3 py-2 font-mono text-xs text-slate-500">{line.barcode ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-800">{line.itemName}</td>
                    <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                      <input
                        ref={(el) => {
                          if (el) qtyInputRefs.current.set(line.key, el)
                          else qtyInputRefs.current.delete(line.key)
                        }}
                        type="number"
                        min="0"
                        step="0.01"
                        value={line.quantity}
                        onFocus={() => setSelectedKey(line.key)}
                        onChange={(event) => updateLine(line.key, { quantity: Number(event.target.value) })}
                        className="w-16 rounded border border-slate-300 px-2 py-1 text-sm"
                      />
                    </td>
                    <td className="px-3 py-2" onClick={(event) => event.stopPropagation()}>
                      <input
                        ref={(el) => {
                          if (el) priceInputRefs.current.set(line.key, el)
                          else priceInputRefs.current.delete(line.key)
                        }}
                        type="number"
                        min="0"
                        step="0.01"
                        // Empty box, not a pre-filled 0, until a price is typed.
                        value={line.unitPrice ?? ''}
                        placeholder="Price"
                        aria-label={`Price for ${line.itemName}`}
                        onFocus={() => setSelectedKey(line.key)}
                        onChange={(event) =>
                          updateLine(line.key, {
                            // Clearing the box goes back to "no price yet"
                            // rather than to 0 — the two mean different things
                            // to `handleCompleteSale`.
                            unitPrice: event.target.value === '' ? null : Number(event.target.value),
                          })
                        }
                        className={`w-24 rounded border px-2 py-1 text-sm ${
                          line.unitPrice == null ? 'border-amber-400 bg-amber-50' : 'border-slate-300'
                        }`}
                      />
                    </td>
                    <td className="px-3 py-2 text-slate-800">
                      {formatCurrency(line.quantity * (line.unitPrice ?? 0))}
                    </td>
                  </tr>
                ))}
                {cart.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                      Scan a barcode or search for an item above to add it here.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="mt-3 flex gap-3">
            <button
              type="button"
              disabled={!selectedKey}
              onClick={() => selectedKey && qtyInputRefs.current.get(selectedKey)?.focus()}
              className="rounded border border-slate-300 bg-slate-50 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Change Quantity [F2]
            </button>
            <button
              type="button"
              disabled={!selectedKey}
              onClick={() => selectedKey && removeLine(selectedKey)}
              className="rounded border border-slate-300 bg-slate-50 px-4 py-2 text-sm text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Remove Item [F4]
            </button>
          </div>
        </div>

        {/* Right panel: customer, totals, payment */}
        <div className="flex w-96 flex-shrink-0 flex-col gap-4 overflow-auto border-l border-slate-200 bg-slate-50 p-4">
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Customer Name
              <div className="relative">
                <input
                  type="text"
                  value={customerName}
                  onChange={(event) => handleCustomerNameChange(event.target.value)}
                  placeholder="Walk-in Customer"
                  className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
                />
                {!selectedParty && customerName.trim() !== '' && partyResults.length > 0 && (
                  <ul className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded border border-slate-200 bg-white shadow-lg">
                    {partyResults.map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          onClick={() => handlePartySelect(row)}
                          className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-100"
                        >
                          <span>{row.name}</span>
                          <span className="text-slate-400">{row.phone ?? '—'}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </label>

            <label className="mt-3 flex flex-col gap-1 text-sm text-slate-600">
              Mobile Number
              <input
                type="text"
                value={customerPhone}
                onChange={(event) => setCustomerPhone(event.target.value)}
                placeholder="Optional for a Walk-in sale"
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
            </label>

            {selectedParty && (
              <button type="button" onClick={handleUseWalkIn} className="mt-2 text-sm text-slate-500 hover:underline">
                Use Walk-in Customer instead
              </button>
            )}

            {/*
              Who made this sale (client request, 2026-08-27). Optional by
              their decision, so a blank box means "Unassigned" rather than
              blocking Complete Sale — the counter is never held up by it. It
              keeps its value between bills; see `salesmanName`. Typed, not
              picked (2026-09-19): the list only suggests, and a new name is
              added when the sale is saved.
            */}
            <label className="mt-3 flex flex-col gap-1 text-sm text-slate-600">
              Salesman
              <input
                type="text"
                list="salesman-names"
                value={salesmanName}
                maxLength={60}
                placeholder="Unassigned"
                autoComplete="off"
                onChange={(event) => setSalesmanName(event.target.value)}
                className="w-full rounded border border-slate-300 px-3 py-2 text-sm text-slate-800 focus:border-slate-500 focus:outline-none"
              />
              <datalist id="salesman-names">
                {salesmen.map((row) => (
                  <option key={row.id} value={row.name} />
                ))}
              </datalist>
            </label>
          </div>

          {partyRequired && !hasPartyInfo && (
            <p className="text-sm text-red-600">Party required for this payment mode.</p>
          )}

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-lg font-semibold text-slate-900">Total {formatCurrency(totals.grandTotal)}</p>
                <p className="text-xs text-slate-500">
                  Items: {cart.length}, Quantity: {totalQuantity}
                </p>
              </div>
              <button type="button" onClick={() => setShowBreakup((open) => !open)} className="text-sm text-blue-600 hover:underline">
                Full Breakup
              </button>
            </div>

            {showBreakup && (
              <div className="mt-3 flex flex-col gap-1 border-t border-slate-100 pt-3 text-sm text-slate-700">
                <p className="flex justify-between">
                  <span>Subtotal</span>
                  <span>{formatCurrency(totals.subtotal)}</span>
                </p>
                <p className="flex justify-between">
                  <span>Discount</span>
                  <span>{formatCurrency(totals.totalDiscount)}</span>
                </p>
                <p className="flex justify-between font-semibold text-slate-900">
                  <span>Grand Total</span>
                  <span>{formatCurrency(totals.grandTotal)}</span>
                </p>
              </div>
            )}

            <label className="mt-3 flex items-center justify-between gap-2 text-sm text-slate-600">
              Discount (₹)
              <input
                type="number"
                min="0"
                step="0.01"
                value={discountInput}
                placeholder="0"
                onChange={(event) => setDiscountInput(event.target.value)}
                className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm text-slate-800"
              />
            </label>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <label className="flex flex-col gap-1 text-sm text-slate-600">
              Payment Mode
              <select
                value={paymentMode}
                onChange={(event) => setPaymentMode(event.target.value as PaymentMode)}
                className="rounded border border-slate-300 px-3 py-2 text-sm text-slate-800"
              >
                <option value="cash">Cash</option>
                <option value="upi">UPI</option>
                <option value="credit">Credit</option>
                <option value="split">Split</option>
              </select>
            </label>

            {paymentMode === 'split' ? (
              <div className="mt-3 flex flex-col gap-2">
                <label className="flex items-center justify-between gap-2 text-sm text-slate-600">
                  Cash amount
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={splitCash}
                    onChange={(event) => setSplitCash(Number(event.target.value))}
                    className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm text-slate-800"
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-sm text-slate-600">
                  UPI amount
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={splitUpi}
                    onChange={(event) => setSplitUpi(Number(event.target.value))}
                    className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm text-slate-800"
                  />
                </label>
                <label className="flex items-center justify-between gap-2 text-sm text-slate-600">
                  Credit amount
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={splitCredit}
                    onChange={(event) => setSplitCredit(Number(event.target.value))}
                    className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm text-slate-800"
                  />
                </label>
                <p className="text-xs text-slate-500">Cash + UPI + Credit must exactly equal the grand total.</p>
              </div>
            ) : (
              <p className="mt-3 text-sm text-slate-600">
                Full amount will be recorded as {paymentMode === 'upi' ? 'UPI' : paymentMode}.
              </p>
            )}

            {cashPortion > 0 && (
              <>
                <label className="mt-3 flex items-center justify-between gap-2 text-sm text-slate-600">
                  Amount Received
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={amountReceived}
                    onChange={(event) => setAmountReceived(event.target.value)}
                    placeholder="0.00"
                    className="w-28 rounded border border-slate-300 px-2 py-1 text-right text-sm text-slate-800"
                  />
                </label>
                <p className="mt-2 flex items-center justify-between text-sm font-medium text-slate-700">
                  <span>Change to Return</span>
                  <span>{formatCurrency(changeToReturn)}</span>
                </p>
              </>
            )}
          </div>

          {savedSale && (
            <div className="flex flex-col gap-2 rounded border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
              <p role="status">
                Sale #{savedSale.id} saved — grand total {formatCurrency(savedSale.grand_total)}.
              </p>
              {isBillDeliveryConfirmed(savedSale) ? (
                <p>
                  {savedSale.print_override_used
                    ? 'Owner override used — ready to print.'
                    : 'WhatsApp sent to customer and Owner — ready to print.'}
                </p>
              ) : (
                /*
                 * Informational, not a blocker. The bill is queued and will be
                 * sent automatically as soon as WhatsApp reconnects, so this
                 * says what is still outstanding rather than what is stopping
                 * the printer — nothing is.
                 */
                <div className="flex flex-col gap-2 text-amber-700">
                  <p>
                    {!savedSale.whatsapp_owner_sent && 'The Owner copy has not gone out yet. '}
                    {!savedSale.whatsapp_customer_sent && 'The customer copy has not gone out yet. '}
                    It is queued and will send by itself once WhatsApp reconnects — you can print now.
                  </p>
                  {/*
                    * The way out for a bill that will never send — a wrong or
                    * unregistered number, say. Without it that sale retries on
                    * every reconnect forever and sits in the undelivered count
                    * forever, which would train the Owner to ignore the count.
                    */}
                  {/*
                    * Owner-only, and since 2026-08-27 that is asked for rather
                    * than assumed: nobody is logged in as the Owner at the
                    * counter, so this used to be a button no session would ever
                    * see. Elevating for the one call and locking straight after
                    * matches the rule everywhere else in the app — Owner access
                    * lasts exactly as long as the Owner thing being done.
                    */}
                  {askingOverride ? (
                    <OwnerPasswordPrompt
                      title="Stop retrying this bill"
                      description="This bill will stop being re-sent on WhatsApp and will leave the undelivered count. It cannot be undone."
                      onUnlocked={handleOverride}
                      onCancel={() => setAskingOverride(false)}
                    />
                  ) : (
                    <button
                      type="button"
                      onClick={() => setAskingOverride(true)}
                      disabled={overriding}
                      className="self-start rounded border border-amber-400 bg-white px-3 py-1.5 text-sm font-medium text-amber-800 hover:bg-amber-50 disabled:opacity-50"
                    >
                      {overriding ? 'Marking…' : 'Stop retrying this bill (Owner)'}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {formError && (
            <p role="alert" className="text-sm text-red-600">
              {formError}
            </p>
          )}

          {printError && (
            <p role="alert" className="text-sm text-red-600">
              {printError}
            </p>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={handleCompleteSale}
              disabled={saving}
              className="flex-1 rounded bg-emerald-600 px-6 py-3 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Complete Sale'}
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={!savedSale || printing || Boolean(savedSale.printed)}
              title={
                !savedSale
                  ? 'Complete a sale first'
                  : savedSale.printed
                    ? 'Already printed — further copies go through the Owner-only reprint flow'
                    : undefined
              }
              className="rounded border border-slate-300 px-4 py-3 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-400 disabled:hover:bg-transparent"
            >
              {printing ? 'Printing…' : savedSale?.printed ? 'Printed ✓' : 'Print Bill'}
            </button>
          </div>
        </div>
      </div>

      <BillPrintSheet sale={savedSale} partyName={savedSalePartyName} />
    </AppShell>
  )
}
