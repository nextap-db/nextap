-- Existing order subtotal and total values remain unchanged.
ALTER TABLE orders ADD COLUMN shipping_fee INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN shipping_zone TEXT NOT NULL DEFAULT '';
ALTER TABLE orders ADD COLUMN delivery_region_code TEXT NOT NULL DEFAULT '';
