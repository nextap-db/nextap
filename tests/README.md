# Regression checks

Run the complete suite from the repository root with Node.js 24 or newer, as required by the package:

```powershell
npm test
```

The Worker suite applies the repository SQL migrations to a new in-memory SQLite database for every test, then calls the Worker through real `Request` and `Response` objects. A small adapter matches the D1 prepared-statement methods used by the backend. Password hashing, signatures, SQL bindings, uploads and stored responses execute normally. Notification delivery and PSGC address lookups use local network stubs.

Checks cover fresh database setup, admin and client authorization, account isolation, profile saves and publication visibility, phone login formats, password/session changes, login rate limits and origin validation, catalog prices, invalid orders, order fulfillment status, NCR and no-province address fallbacks, image formats and aggregate database limits. Multipart checks verify the streaming request limit without a Content-Length header and safe errors on malformed bodies. JavaScript files and executable HTML script blocks are also parsed.

The complete command also runs frontend behavior tests using a browser-like DOM stub, schema reconciler tests covering fresh and partially migrated databases, and deployment helper tests using local fetch stubs. It verifies deployment configuration checks and exact-commit polling without deploying anything. To run only the Worker suite, use `node --test tests/regression.test.mjs`.

These are local regression checks. They do not deploy, call production services, verify the Cloudflare D1 service itself or replace browser/mobile layout checks.

Content-plan checks cover Basic 3, Premium 6 and Elite unlimited published sections,
free identity/contact links, retained hidden drafts, existing over-limit content,
admin plan changes, Featured uploads and concurrent saves. The actual Worker and
SQLite tests verify that stale saves cannot consume another slot or recreate a
deleted profile. Frontend checks exercise actual dashboard handlers and preserve
untouched business hours when calculating the allowance.
