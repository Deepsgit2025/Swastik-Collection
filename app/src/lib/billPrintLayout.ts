/**
 * Bill print sizing (PHASE7.md section 1), for the same Posiflow ShipPro
 * 4-inch printer Phase 4's labels already target (see labelLayout.ts) —
 * callers should reuse that file's `mmToIn` helper directly rather than
 * duplicating it.
 *
 * A bill isn't die-cut stock like a label (fixed width AND height): it's
 * continuous-roll receipt paper — fixed width, with a length that grows
 * with however many items are on the sale. `BILL_WIDTH_MM` is only the
 * width; BillPrintSheet.tsx's `@page` rule deliberately leaves the height
 * as `auto` for that reason, so the printer isn't clipped to (or padded
 * out to) a fixed page length.
 *
 * 101.6mm (4in) is the nominal roll width per the printer's name. Like
 * Phase 4's label dimensions, this hasn't been confirmed against the real
 * ShipPro hardware yet (PHASE7.md section 6 criterion 1 is unverified for
 * the same reason PHASE4.md's hardware criteria are — see CLAUDE.md's
 * Phase 4 status note) — adjust here if the real printable width differs
 * once hardware is on hand.
 */
export const BILL_WIDTH_MM = 101.6
