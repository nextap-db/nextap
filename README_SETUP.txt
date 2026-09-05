NexTap — Cloudflare Workers + D1 (No R2)
=====================================

This version keeps the approved NexTap UI (including Light/Dark mode) but moves client data to Cloudflare D1 and profile photos to Cloudflare R2.

Prerequisites
-------------
1. A Cloudflare account.
2. Node.js 16.17+.
3. A terminal/PowerShell.

First-time setup
----------------
Open a terminal in this folder and run:

  npm install
  npx wrangler login

Create the D1 database:

  npx wrangler d1 create nextap-db

Copy the database_id printed by Wrangler into wrangler.jsonc:

  "database_id": "PASTE_D1_DATABASE_ID_HERE"

Create the R2 bucket:

  
Apply the database schema remotely:

  npx wrangler d1 migrations apply nextap-db --remote

Deploy:

  npx wrangler deploy

Wrangler will print the public https://...workers.dev URL.

Local development
------------------
  npx wrangler dev

Notes
-----
- Client records are stored in D1, not a local JSON file.
- Profile photos are stored in R2, not the local uploads folder.
- /admin/ is the admin page.
- /profile/<slug> is the public profile page.
- This first migration intentionally keeps the existing admin UI and behavior.
- IMPORTANT: the admin page is currently not password-protected. Add authentication before selling/launching publicly.
- Existing local clients.json data is NOT automatically imported. The included migration only creates the table. Add clients through /admin or import them separately.

NO-R2 NOTE
- Profile images are converted to data URLs and stored directly in D1.
- Image upload limit is 2 MB per profile photo.
- This avoids R2 and does not require an R2 subscription.
- For a large commercial deployment with many/high-resolution photos, moving photos to object storage later is recommended.
