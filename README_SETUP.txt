NexTap - Cloudflare Workers + D1 (No R2)
=====================================

The existing NexTap pages, themes, profile links, dashboard, and checkout remain
on Cloudflare Workers. Client records, orders, and inline image data URLs use D1.
Static pages and assets use the Worker ASSETS binding. This project does not use
R2 and requires no R2 bucket or subscription.

Requirements
------------
- Node.js 24 or newer supported LTS, npm, and a Cloudflare account.
- A D1 database whose ID is configured in wrangler.jsonc.
- ADMIN_PASSWORD on the Worker. CLIENT_AUTH_SECRET is recommended as a separate
  strong signing secret for client sessions and hashed login-limit keys.

Local development (does not change production)
---------------------------------------------
  npm ci
  npm test
  node scripts/reconcile-d1.mjs --local --apply
  npm run dev

Create a local .dev.vars file with your local ADMIN_PASSWORD and
CLIENT_AUTH_SECRET. Keep that file out of version control. Local Wrangler data
is independent of the remote database. The first schema migration seeds a demo
Christian profile; remove or customize it through the admin before launch.

First-time Cloudflare setup
--------------------------
  npx wrangler login
  npx wrangler d1 create nextap-db

For a NEW installation, set database_id in wrangler.jsonc to the created ID.
For the existing project, retain its current database ID and bindings.
Configure secrets without putting their values into source files:
  npx wrangler secret put ADMIN_PASSWORD
  npx wrangler secret put CLIENT_AUTH_SECRET

Then follow the backup/staging procedure below before remote reconciliation.

Schema reconciliation
---------------------
Read-only inspection (exits 1 if missing schema or history needs repair):
  node scripts/reconcile-d1.mjs --remote --check

Apply and verify reviewed ADDITIVE migrations:
  node scripts/reconcile-d1.mjs --remote --apply

Use this script for an existing database with manually added columns or old
migration-history drift. It inspects sqlite_master, PRAGMA table_info, and index
columns, executes only missing operations, verifies actual schema effects, and
only then records an unrecorded migration by name. It retains existing client
values, extra columns, migration IDs, timestamps, and unknown history records.
Recorded migrations with missing schema are repaired without rewriting their
history. The historical demo seed runs only when the clients table did not
exist at the initial inspection. For an existing clients table with missing
seed history, the script verifies the existing schema and records that
migration as an explicit existing-data baseline, logging that the demo seed
was not replayed. Existing/customized demo clients stay intact; deleted or
never-used demo clients are not recreated. This does not infer or replay past
client data changes. Manually added columns with compatible SQLite affinity and
required constraints are retained, including their existing defaults.

The script fails before changes if it finds incompatible existing columns or
indexes. It does not drop/rebuild tables, change existing column definitions,
or infer destructive data conversions. Unsupported future SQL requires an
explicit reviewed update to the script. Stop and inspect drift on staging if
verification fails. A partially completed additive run can be retried safely.

All checked-in SQL files still bootstrap a clean database with standard SQLite
or Wrangler migrations. Keep historical names, including the two existing
0013 files, unchanged. Use unique increasing numbers for future migrations.
0015 adds the 23 previously missing client columns. 0016 adds expiring D1 login
attempt counters. Do not use the previous blind INSERT INTO d1_migrations step.

Backup, staging, and release
---------------------------
1. Export the current D1 database using the Cloudflare dashboard or:
     npx wrangler d1 export nextap-db --remote --output work/nextap-before.sql
   Keep the export private; it contains client data, image data, and passwords
   hashes. Record the existing deployment/version ID and verify the export can
   be read/restored to a separate staging database.
2. Copy wrangler.jsonc to wrangler.staging.jsonc in the project root. Set a
   distinct Worker name, staging database name/ID, and staging bindings. Import
   a private copy of the backup into staging; do not send real notifications.
   Example commands with the staging configuration:
     node scripts/reconcile-d1.mjs --config wrangler.staging.jsonc --database nextap-db-staging --remote --check
     node scripts/reconcile-d1.mjs --config wrangler.staging.jsonc --database nextap-db-staging --remote --apply
     npx wrangler deploy --config wrangler.staging.jsonc
3. On staging, verify existing profile URLs/data, hidden modules, client/admin
   sign-in, client creation/editing, photos, all card checkout prices, stored
   design instructions, and orders. New session verification requires existing
   client users to sign in once after upgrade; their credentials stay intact.
4. Run npm test. Confirm the production target, backup, D1/API permissions, and
   notification secrets before enabling the main-branch deployment workflow.
5. Reconcile production schema, deploy, and confirm /__nextap-version reports
   the released source commit. The workflow performs the last steps in order.

The schema changes are additive so the previous Worker can run against the
expanded schema. If a release misbehaves, roll back the Worker to its recorded
previous version and inspect data before changing it. Do not drop the added
columns/tables during a Worker rollback. Restoring D1 overwrites later writes;
restore only with an explicit data-recovery plan that accounts for new orders
and client edits. Do not run concurrent reconciliation/deployment jobs against
the same database; production CI serializes them.

GitHub Actions configuration
----------------------------
PRs run JavaScript/regression checks and a Worker bundle dry run. Successful
main pushes or main workflow dispatches can deploy. Required repository secrets:
- CLOUDFLARE_ACCOUNT_ID: the account owning the configured Worker and D1.
- CLOUDFLARE_API_TOKEN: scoped permissions required by wrangler deploy for this
  account, including Workers Scripts edit and required account metadata access.
- CLOUDFLARE_D1_API_TOKEN: D1 read/edit for the configured account/database.
NEXTAP_DEPLOY_URL uses the repository variable first, then a same-named secret,
then the verified existing origin https://nextap.digitalprofile.workers.dev.
Override it for your configured custom-domain origin when needed. It must have
no path/query/credentials. The existing production database UUID is checked
explicitly; changing installations requires reviewing the release preflight.

Configuration is checked before D1 or Worker mutations. CI also verifies the
production D1 UUID/backend and a Cloudflare Time Travel recovery bookmark,
then exports to a private temporary runner directory. It redirects ALL export
and import command output because export logs contain a signed download URL.
No dump, private log, local credentials, or SQL data is committed, cached, or
uploaded as an artifact. Temporary files are removed on success/failure.

The export is restored into the marked SQLite file of an isolated LOCAL
Wrangler D1 state. Direct SQLite restore preserves full inline image values
that exceed the D1 SQL statement-length limit; it never targets remote D1.
The initializer marker is removed and foreign-key integrity is checked.
Failed commands publish only fixed diagnostic categories, never SQL/error data.
CI reconciles
that copy and verifies hashes/counts of every original client/order column.
Only aggregate record counts and budget audit totals enter public logs.
Existing oversized rows/images or invalid order-items JSON stop the release.
A local Worker with generated credentials then exercises synthetic client
sign-in/profile saves and order fulfillment; notification credentials are
omitted. No real client/order is edited and no notification is sent by this
stage. Production reconciliation/deployment proceeds only after staging passes.

The recovery bookmark is masked and privately held on the runner during the
preflight. The public log records its UTC timestamp and, when accessible, the
previous Worker version IDs. The bookmark is requested with that exact UTC
timestamp, so authenticated time-travel info --timestamp with the same value
recreates the same bookmark after temporary files are removed. Cloudflare keeps
Time Travel history separately; the temporary export is a staging copy, and
Time Travel is the durable recovery mechanism within its retention period.
Time Travel retains 7 days on Workers Free or 30 days on Paid. It is a recovery
checkpoint, and an independent private export may be retained by the operator
for longer-lived backups. Never automatically restore D1: later orders/edits
must be considered. A failed CI run can leave additive schema or an active
Worker version after later deployment steps; inspect the serving version first.

The deploy command
embeds GITHUB_SHA as BUILD_COMMIT and must exit successfully. The next step
fetches the serving version endpoint and requires the exact SHA. An uploaded
version or account-metadata error does not count as a successful deployment.
Local/staging deployments without BUILD_COMMIT report development, so add a
real commit definition when using the verifier outside GitHub Actions.

Optional order notification secrets on the Worker
-------------------------------------------------
Email: RESEND_API_KEY, ADMIN_EMAIL, RESEND_FROM_EMAIL.
WhatsApp: WHATSAPP_ACCESS_TOKEN, WHATSAPP_PHONE_NUMBER_ID, ADMIN_WHATSAPP_TO.
Configure only channels you use. Orders are stored before notification attempts;
missing or failed notifications require inspection of the stored orders.

Operational behavior
--------------------
- /admin/ and /admin/orders are protected by admin authentication.
- /client-login and /client-dashboard serve client sign-in and dashboard pages.
- /profile/<slug> keeps public profile URLs. Hidden fields are omitted from
  public API responses while authenticated owners retain their saved content.
- Login attempts have 15-minute limits: 10 per account identifier and 40 per
  Cloudflare-provided IP in each auth namespace. Counter keys are HMAC hashed.
- Image uploads accept validated JPG/PNG/WebP. The server limits an encoded
  image data URL to 1,700,000 bytes, a full profile/order to 1,800,000 bytes, and
  JSON requests to 2,000,000 bytes. Use optimized images; two large images may
  exceed the shared row budget. Existing images remain stored as before.
- No migration imports a separate legacy clients.json automatically.

Verification limits
-------------------
The included SQLite and mocked Worker tests protect the reviewed behavior.
They do not replace a real Cloudflare staging run, live notification checks,
or a mobile/browser visual check. Changes have not been deployed by this bundle.
