ALTER TABLE clients ADD COLUMN business_location_name TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN business_location_link TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN show_business_location INTEGER DEFAULT 1;
