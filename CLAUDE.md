# CLAUDE.md

Context for AI coding agents working in this repo.

## What this is
A small TypeScript proof of concept for the Oncade **Platform API** (test environment only): it creates a business, then
takes an invoice through draft → sent → cancelled (or paid), receiving and verifying signed webhooks along the way.

## Sources of truth (read these before changing API calls)
- Getting started: https://pay.oncade.xyz/docs/platform-getting-started
- Invoices guide: https://pay.oncade.xyz/docs/guides/platform-invoices
- Businesses guide: https://pay.oncade.xyz/docs/guides/platform-businesses
- Full reference: https://pay.oncade.xyz/docs/api-reference/platform
- Webhook guide (game-dev docs, same signature scheme): https://dev.oncade.xyz/docs/guides/webhooks

When the guide and the reference disagree, trust **actual API responses**, then the guide, and record the conflict in
`FEEDBACK.md`. Known conflicts already logged there (e.g. `metadata` vs `externalMetadata` on invoices).

## API facts we rely on
- Host `https://www.oncade.gg/api`, paths `/v1/platform/...`. No separate test host: the key decides the environment.
- Headers: `Authorization: Bearer <key>`, `X-Oncade-API-Version: v1`, `X-Target-Business-Id` for business-scoped calls,
  `Idempotency-Key` on every POST/PUT/PATCH (the client adds one automatically).
- Webhooks: `x-oncade-signature` = hex HMAC-SHA256 of the **raw body** with the platform webhook secret. Never verify a
  re-serialised body. No event id is documented, so we dedupe on a SHA-256 of the raw body.

## Verified against the live test API (overrides the docs)
- `GET /me`: scopes are in `keyInfo.activeScopes`, plus a top-level `approvedScopes`. Effective = intersection.
- `Idempotency-Key` must be a UUID (400 otherwise), and it is **not enforced**: the same key creates duplicates. Don't rely on it for safety.
- Invoice webhooks carry `data.invoiceId`, `status`, `total`, etc., but not `externalMetadata`.

## Rules
- Never run against a live key. `src/config.ts` refuses keys without the `oncade_platform_test_` prefix - keep it.
- Never commit `.env` or print the API key / webhook secret. The client redacts the key in debug logs.
- Keep zero runtime dependencies (Node ≥ 20.6 built-ins: fetch, http, crypto, `--env-file`).
- `npm run typecheck && npm test` must pass before committing.

## Layout
- `src/client.ts` typed API client · `src/webhooks.ts` signature verification + http handler
- `src/server.ts` webhook receiver · `src/flow.ts` end-to-end demo · `src/eventlog.ts` file-backed event log shared
  between the two processes · `test/` node:test suites
