/**
 * Label layout constants (PHASE4.md section 3), used by both the on-screen
 * preview and the print sheet so they can never drift apart.
 *
 * The physical label size used to be hardcoded here at 50mm x 25mm (2in x
 * 1in), matching the die-cut stock the client confirmed at the time. It's
 * now a persisted setting (`src/db/settings.ts`, `getLabelSize`/
 * `setLabelSize`, Owner-only to edit via the `settings:edit` permission) so
 * the shop can switch to different label stock without a code change.
 * `DEFAULT_LABEL_WIDTH_MM`/`DEFAULT_LABEL_HEIGHT_MM` below are only the
 * fallback used before that setting has ever been saved (or while it's still
 * loading) — they intentionally match the original client-confirmed size.
 */
export const DEFAULT_LABEL_WIDTH_MM = 50
export const DEFAULT_LABEL_HEIGHT_MM = 25

/** Sanity bounds for the Label Size setting — thermal label stock this small/large doesn't exist for the ShipPro. */
export const MIN_LABEL_DIMENSION_MM = 10
export const MAX_LABEL_DIMENSION_MM = 150

export function mmToIn(mm: number): number {
  return mm / 25.4
}
