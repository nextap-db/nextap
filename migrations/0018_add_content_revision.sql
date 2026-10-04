-- Serialize content saves so concurrent edits cannot exceed the plan budget.
-- Existing customer content and visibility settings remain unchanged.
ALTER TABLE clients ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0;
