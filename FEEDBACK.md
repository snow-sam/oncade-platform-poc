# Part 2 feedback: Platform docs & integration

Each item: where, what I did, what I expected, what happened. Tags: **broken**, **feels broken**, **confusing**.

## Docs

### 1. [Broken] Invoice `metadata` is documented in the reference but rejected by the API
- **Where:** https://pay.oncade.xyz/docs/api-reference/platform → Create Invoice, compared with https://pay.oncade.xyz/docs/guides/platform-invoices
- **What I did:** Read both pages to build the invoice payload.
- **Expected:** One field name for custom invoice data.
- **What happened:** The reference lists `metadata` ("Arbitrary key-value metadata"). The guide says `metadata` returns 400 and you must use `externalMetadata`. I used `externalMetadata`.

### 2. [Confusing] Campaign `payoutAmount` has two different units and types
- **Where:** API reference (Create Campaign / Record Event) vs https://pay.oncade.xyz/docs/guides/platform-payouts
- **What happened:** The reference uses `"payoutAmount": 500` (a number, in USD). The payouts guide uses a string in USDC base units (`"5000000"` = $5.00). If an integrator gets this wrong, they pay out 10,000× too much or too little.

### 3. [Broken] Campaign user-link path in the payouts guide doesn't exist in the reference
- **Where:** https://pay.oncade.xyz/docs/guides/platform-payouts
- **What happened:** The guide uses `POST /v1/platform/campaigns/{id}/link/users/initiate`. The reference defines `POST /v1/platform/campaigns/{id}/users/{userRef}/link/initiate` (userRef `new`) and also lists `/link-sessions`.

### 4. [Confusing] `X-Campaign-Id` is "required" but missing from every example
- **Where:** API reference → Common Headers, compared with the wallet balance, link details and fund session examples
- **What happened:** The Common Headers section says campaign operations require `X-Campaign-Id`, but none of the endpoint examples send it.

### 5. [Feels broken] The campaign webhook payload includes its own `webhookSecret`
- **Where:** API reference → campaign webhook payloads
- **What happened:** Sending the signing secret inside the payload it authenticates defeats the signature. The docs also don't say whether campaign deliveries are signed with the platform secret or the per-campaign secret.

### 6. [Confusing] Webhook delivery contract is incomplete
- **Where:** API reference → Webhooks
- **What happened:**
  - It only says "Delivery is retried", with no retry count, backoff, timeout or expected status code. The 2xx-within-10s rule appears only in the *game* webhook guide on dev.oncade.xyz.
  - There's no event or delivery id, so you can't dedupe reliably (I hash the raw body instead).
  - **Observed in the live run:** I restarted my tunnel, which gave it a new URL, and updated the webhook URL in the portal.
    The first `Platform.Invoice.Created` delivery then failed against the old URL, and it arrived **60.6s** later at the new
    URL. So retries happen (the first one after ~60s) and use the URL configured *at retry time*. That's good behaviour,
    but none of it is documented. A client waiting 60s just misses it, and the receiver can't tell a retry from a first
    attempt. Publishing the retry schedule, or adding a delivery id and attempt number to the headers, would remove the guesswork.
  - Invoice event payloads aren't shown at all. The docs say to "match via externalMetadata", but don't say whether `externalMetadata` or the invoice id is in `data`.

### 7. [Confusing] Two different campaign products with no cross-reference
- **Where:** https://dev.oncade.xyz/docs/guides/campaigns compared with the Platform campaigns docs
- **What happened:** The dev guide describes game campaigns: a different API key type, `/api/v1/campaign/{id}`, events like `Campaign.Started`, and 202 responses. The Platform docs use `/v1/platform/campaigns` and `Platform.Campaign.*`. Neither page mentions the other, so it's unclear which one a platform should use.

### 8. [Confusing] Hosts are spread across four domains
- **What happened:** Docs live on `pay.oncade.xyz`, the portal on `dev.oncade.xyz`, the API on `www.oncade.gg`, and hosted pages on both `oncade.gg` and `pay.oncade.gg`. The guides use a `https://<host>/...` placeholder, and I found the real host only in the getting-started page. Since `.xyz` is the docs/test domain, I first assumed the test API lived there too.

### 9. [Confusing] Smaller inconsistencies
- Event name casing: the payouts guide says `platform.distribution.cancelled`, while the reference says `Platform.Distribution.Cancelled`.
- Field casing: `userRef` vs `user_ref`. The `User.Account.Link.*` payloads have no `timestamp`, even though "all payloads have event, data, timestamp".
- `User.Account.Link.Canceled` (one L) vs `Platform.Invoice.Cancelled` (two L's).
- The business member role `game_editor` (shown as "Editor") is odd for non-game platforms.
- The error response shape, rate limits and full status enums (distributions, campaigns) aren't documented.
- Pagination shape differs per endpoint (`pagination{}` vs `hasNextPage` vs `total`).
- The gift flow depends on an unnamed "contract-sdk".
- The invoice example shows `payerFee: 25` on a $50 invoice with no fees, but the Oncade fee rate isn't documented.

## Integration run (test environment, 2026-11-19)

Result: the full invoice lifecycle **works end to end**: business create → readiness → draft → send → cancel. All three
invoice webhooks arrived signed, and HMAC verification passed on the first try. The issues below came from the live run.

### 10. [Broken] `Idempotency-Key` is required but not enforced, so retries create duplicate invoices
- **Where:** `POST /v1/platform/invoices` (reproduce with `npm run idempotency:check`)
- **What I did:** Sent the same UUID `Idempotency-Key` three times: twice with the same body, once with a different body.
- **Expected:** The 2nd call returns the original invoice. The 3rd call gets a 409/422 for key reuse with a different payload.
- **What happened:** All three calls returned 201, and **three different invoices** were created (`…5c7e`, `…5c8c`, `…5c9a`).
  Getting-started tells integrators to send the header on every POST/PUT/PATCH, so they'll rely on it. A client that
  retries after a timeout will double-bill the payer.

### 11. [Confusing] `Idempotency-Key` must be a UUID, which isn't documented
- **Where:** `POST /v1/platform/invoices`
- **What I did:** Sent `Idempotency-Key: invoice-<uuid>`, a common prefixed-key pattern.
- **What happened:** `400 {"error":"Invalid Idempotency-Key format. Expected UUID format."}`. The format rule is fine, but it
  should be in the docs. The error message itself is clear.

### 12. [Confusing] `GET /v1/platform/me` response doesn't match the documented shape
- **Where:** `GET /v1/platform/me`
- **Expected (docs):** Top-level `activeScopes` and `pendingScopes`.
- **What happened:** The scopes come back under `keyInfo.activeScopes`, and there's an undocumented top-level `approvedScopes`.
  Code written from the docs reads `activeScopes` as empty. Mine did, and would have sent an empty `grantScopes` when
  creating the business.

### 13. [Confusing] Test key holds about 45 scopes the platform hasn't approved
- **Where:** dev.oncade.xyz → API key creation, then `GET /v1/platform/me`
- **What happened:** The key's `activeScopes` include campaign, distribution, gift, vc, item and similar scopes, but `approvedScopes`
  only has platform, business and invoice scopes. The docs say business scopes are auto-approved in test, and `pendingScopes` is
  `[]`, so nothing tells you how to get the rest approved or why they weren't. The platform's own `status` is `"pending"`, and that
  isn't explained either.
- **Related:** The key creation form starts with **no scopes selected**, and nothing marks `platform:read` as needed. My
  first key didn't include it, so even `GET /me`, the first call every guide makes, returned 403. The error message was clear
  (`API key does not have required scope: platform:read`). Pre-selecting `platform:read`, or the scopes a guide needs,
  would remove this first stumble.

### 14. [Confusing] Invoice webhook payloads differ from the docs (in a good way)
- **Where:** `Platform.Invoice.Created`, `.Sent` and `.Cancelled` deliveries
- **Docs say:** Invoice events "carry no custom data; match via externalMetadata then GET the invoice".
- **What happened:** `data` includes `invoiceId`, `invoiceNumber`, `businessId`, `receiverName`, `receiverEmail`, `total`, `currency`,
  `status`, `environment` and `publicInvoiceId`. That's useful, but it doesn't include `externalMetadata`, which is the field the docs tell you to match on.
  Please document the real payload.

### 15. [Confusing] Fees and hosted links
- `payerFee` was `0.3` on a `$60` invoice (0.5%). The rate isn't documented anywhere. The API does return it:
  `GET /v1/platform/invoices/:id` includes `paymentSummary.fees: [{ label: "Service Fee", percentageRate: 0.5, flatRateCents: 0, amountCents: 30, source: "oncade" }]`.
  So only the docs are missing. Documenting `paymentSummary.fees` and the current rate would let integrators show the
  payer's total before creating an invoice.
- Hosted links (`links.invoice`, `home`, `kyb`, `signIn`) point to `pay.oncade.xyz`, but the docs show `pay.oncade.gg`.
- In test, readiness reports `kybVerification: "complete"` right away for a new business. That's convenient, but it isn't
  documented, so integrators can't tell whether test mode skips KYB or whether it ran.
