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

## Integration run (test environment)

_Filled in from the live run. See README → "How AI was used"._
