export interface BarcodeLabelRow {
  id: number
  item_name: string
  price: number | null
  barcode_value: string
  header: string | null
  line1: string | null
  line2: string | null
  line3: string | null
  line4: string | null
  created_by_user_id: number
  created_at: string
}

export interface BarcodeLabelListFilters {
  search?: string
  /**
   * Caps how many rows come back, newest first.
   *
   * Added for the sale screen's always-open item dropdown, which asks for the
   * catalogue with no search term at all — unbounded, that query grows with
   * every label the shop has ever generated, and the dropdown can only show a
   * screenful anyway. Omitted (every other caller) still means no limit.
   */
  limit?: number
}

/** `customCode`, if given, must be unique across `barcode_labels`; left blank/omitted, a unique value is auto-generated server-side (PHASE4.md section 2). */
export interface CreateBarcodeLabelInput {
  itemName: string
  price?: number | null
  customCode?: string | null
  header?: string | null
  line1?: string | null
  line2?: string | null
  line3?: string | null
  line4?: string | null
}
