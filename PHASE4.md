# PHASE4.md — Barcode: Generation + Scanning + Label Printing

> Self-contained. Assumes Phases 1–3 complete. Read CLAUDE.md first.

## 0. What This Phase Is For

Two separate capabilities that both revolve around barcodes: (1) generating and printing labels on the shop's own printer, since they don't use pre-printed supplier barcodes (no purchase module, remember), and (2) scanning those barcodes back in during a sale (Phase 5 consumes this, doesn't build it).

## 1. Confirmed Hardware (do not assume different hardware)

- **Label/receipt printer**: Posiflow ShipPro 4-inch, USB/Bluetooth thermal.
- **Barcode scanner**: Helett HT410 — wired USB, keyboard-wedge/HID, plug-and-play, no driver required, configurable suffix (can be set to send Enter or Tab after each scan).

## 2. Barcode Generation Screen (`/barcode-generator`)

- Form: item name, price, optional custom code (or auto-generate one if left blank)
- Barcode symbology: Code128 (simplest, no strict format requirements, good default for a shop generating its own codes — use `jsbarcode` or `bwip-js` to render)
- Preview of the generated label before printing (name, price, barcode, rendered to match the label template from section 4)
- "Print" and "Print batch" (e.g. print the same label N times — useful when labeling multiple units of the same item) — enter a quantity, print that many copies
- Every generated barcode is saved to the `barcode_labels` table (already in Phase 2 schema) for future reference/reprint, with `barcode_value` unique

## 3. Label Template / Settings (minimal version — full Settings module is Phase 12)

For this phase, hardcode a single reasonable label layout sized for the ShipPro 4-inch: item name (top), price (middle, larger font), barcode + human-readable code (bottom). Don't build a configurable template editor yet — that's a nice-to-have that can be pulled into Phase 12's Settings if the client wants it later. Just get one clean, correctly-sized layout working reliably first.

## 4. Print Pipeline

- Default path: Windows print dialog via Electron's print APIs, targeting the ShipPro's Windows driver (it's USB/Bluetooth and Windows-driver-compatible per the confirmed hardware).
- **If label alignment or print quality is poor via the standard print dialog during testing**, fall back to direct ESC/POS (or the printer's native label command set, check ShipPro documentation) via a raw USB/serial write — flag this to the user if it's needed, since it's a meaningfully different code path than the driver-based default. Try the simple path first; don't pre-build the ESC/POS fallback speculatively if the driver path works fine in testing.

## 5. Barcode Scanning (built now, consumed by Phase 5's sale screen)

The Helett HT410 behaves as a fast keyboard: scanning a code effectively "types" the code's characters rapidly followed by Enter (or Tab, depending on suffix config). Build a reusable hook/utility, e.g. `useBarcodeScanner(onScan: (code: string) => void)`, that:
- Listens for keystroke events in rapid succession (short inter-keystroke delay, e.g. under ~50ms between characters, to distinguish a scan from human typing)
- On detecting the terminating Enter/Tab, calls `onScan` with the accumulated string
- Is attachable to any screen (used first in the Sale screen in Phase 5, but build and unit-test it standalone here since it has no dependency on the sale flow existing)

Build a small dev-only test screen (`/dev/scanner-test`) for this phase that shows scanned codes as they come in, purely to verify the hook works correctly with the real HT410 hardware before Phase 5 needs it.

## 6. Permission Wiring

| Action | Owner | Salesman |
|---|---|---|
| Generate/print barcode labels | ✅ | ✅ |
| View label history (`barcode_labels` list) | ✅ | ✅ (own-created and others' — labels aren't salesman-specific data, this is shop inventory-adjacent info, not financial, so no restriction needed) |

No new `Action` types should be needed beyond what's reasonable to add to Phase 2's `PERMISSIONS` table (e.g. `barcode:create` — allowed for both roles). If Claude Code finds it needs a new action, add it to the central table in `/src/db/permissions.ts`, don't create a separate local check.

## 7. Out of Scope This Phase

- No sale-screen integration yet (Phase 5 wires the scanner hook into the actual cart)
- No configurable label template editor (basic version now, revisit in Phase 12 only if requested)
- No inventory/stock deduction of any kind — generating a label does not create or track a stock count anywhere, this app has no inventory module, ever

## 8. Acceptance Criteria

1. A label generated in the app and printed on the real Posiflow ShipPro scans correctly when read back by the Helett HT410 on the dev scanner-test screen
2. Batch printing (e.g. 10 copies of one label) completes without spooler errors or duplicate/skipped labels
3. Every generated label is saved to `barcode_labels` with a unique `barcode_value` — attempting to reuse an existing custom code shows a clear error rather than a silent duplicate/DB constraint crash
4. The `useBarcodeScanner` hook correctly distinguishes a real scan from a human typing into a nearby text field during manual testing (i.e., normal typing in a search box doesn't falsely trigger `onScan`)
5. Both Owner and Salesman can access the barcode generator and print labels

## 9. Prompts for Claude Code

**Prompt 1 — Barcode Generation**
```
Read PHASE4.md fully and CLAUDE.md for permanent rules. Build the barcode generator screen per section 2, using jsbarcode or bwip-js for Code128 generation, saving every generated label to the barcode_labels table with a unique barcode_value. Include a clear error (not a raw DB crash) if a custom code is reused.
```

**Prompt 2 — Label Template + Print Pipeline**
```
Build the single hardcoded label layout per section 3, sized for the Posiflow ShipPro 4-inch, and wire up printing per section 4 — try the standard Windows print dialog path first. Include batch printing (print quantity N of the same label). If you hit alignment/quality problems in testing, tell me before building the ESC/POS fallback rather than assuming it's needed.
```

**Prompt 3 — Scanner Hook**
```
Build the useBarcodeScanner hook per section 5 — fast-keystroke detection distinguishing a real scanner input from human typing, terminated by Enter/Tab. Add the dev-only /dev/scanner-test screen so I can verify it against the real Helett HT410 hardware. This hook needs to be clean and reusable since Phase 5's sale screen will consume it directly.
```

**Prompt 4 — Verify**
```
Go through PHASE4.md section 8 acceptance criteria one by one. For criterion 1 and 4, I'll test with the physical hardware myself and confirm — walk me through exactly what to do to test each.
```
