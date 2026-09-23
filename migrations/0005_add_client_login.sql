ALTER TABLE clients ADD COLUMN login_password_hash TEXT DEFAULT '';
ALTER TABLE clients ADD COLUMN login_password_salt TEXT DEFAULT '';
