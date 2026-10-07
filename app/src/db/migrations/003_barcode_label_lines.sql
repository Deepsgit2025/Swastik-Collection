-- Extra freeform tag lines (header + up to 4 lines), added alongside the
-- existing item_name/price fields so labels can carry shop-chosen text
-- (size, batch, MRP note, etc.) in addition to the structured fields.
ALTER TABLE barcode_labels ADD COLUMN header TEXT;
ALTER TABLE barcode_labels ADD COLUMN line1 TEXT;
ALTER TABLE barcode_labels ADD COLUMN line2 TEXT;
ALTER TABLE barcode_labels ADD COLUMN line3 TEXT;
ALTER TABLE barcode_labels ADD COLUMN line4 TEXT;
