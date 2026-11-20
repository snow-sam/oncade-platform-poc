# oncade-platform-poc

A small TypeScript integration with the [Oncade Platform API](https://pay.oncade.xyz/docs/platform-getting-started)
in the **test environment**. It takes the **invoices** flow end to end, including signed webhooks:

```
GET  /v1/platform/me                    verify key + scopes
POST /v1/platform/business              create business, auto-grant this platform   (or reuse one)
GET  /v1/platform/business/readiness    wallet / address / KYB status
POST /v1/platform/invoices              draft invoice          ──▶ Platform.Invoice.Created
POST /v1/platform/invoices/:id/send     send                   ──▶ Platform.Invoice.Sent
GET  /v1/platform/invoices/:id          read back (API = source of truth)
POST /v1/platform/invoices/:id/cancel   clean up               ──▶ Platform.Invoice.Cancelled
                                        (or --keep and pay it)  ──▶ Platform.Invoice.Paid
```

It has no runtime dependencies (only Node built-ins: `fetch`, `http`, `crypto`). The dev dependencies are `tsx` and `typescript`.

## What's in it

| File | What |
|---|---|
| `src/client.ts` | Typed client: auth, API version, `X-Target-Business-Id`, automatic `Idempotency-Key` on POST/PUT/PATCH, typed errors, redacted debug logging |
| `src/webhooks.ts` | HMAC-SHA256 verification over the **raw body** with a constant-time compare; http handler (401 bad sig, 400 bad JSON, 200 on duplicate, 500 on handler error so Oncade retries) |
| `src/server.ts` | Webhook receiver on `:3000/webhooks/oncade`, writes events to `.data/events.jsonl` |
| `src/flow.ts` | The end-to-end run above. It waits for each webhook and falls back to polling the API if the receiver isn't running |
| `src/selftest.ts` | Sends valid, replayed, wrong-secret and unsigned deliveries to the local receiver |
| `test/` | `node:test` suites for signature verification, the handler and the client headers |
| `FEEDBACK.md` | Part 2 feedback: doc bugs and confusion found while building |
| `CLAUDE.md` | The context file the AI agent worked from |

Safety: `config.ts` refuses any key that isn't `oncade_platform_test_…`.

## Run it

Requirements: Node ≥ 20.6, plus [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for a public webhook URL (no account needed).

```bash
npm install
cp .env.example .env          # fill ONCADE_API_KEY, ONCADE_WEBHOOK_SECRET, BUSINESS_OWNER_EMAIL
npm test                      # offline unit tests

# terminal 1 - webhook receiver
npm run webhooks
# terminal 2 - public tunnel; copy the https://….trycloudflare.com URL
npm run tunnel
#   → dev.oncade.xyz → your test platform → Settings → Webhook URL = https://<tunnel>/webhooks/oncade
npm run webhook:selftest      # optional: proves signature checks locally

# terminal 3 - the flow
npm run whoami                # sanity check: platform id, env=test, scopes
npm run flow                  # draft → sent → cancelled
npm run flow -- --keep        # leave it "sent" and print the pay link
npm run flow -- --new-business
```

The test key needs these scopes: `platform:read`, `business:create`, `business:read`, `business:update` and `invoice:*`. Test keys approve them automatically.
Set `ONCADE_DEBUG=true` to log every request and response.

## How AI was used

**Tools:** Claude Code (Claude Opus) in the terminal. One agent session did the whole exercise, and one sub-agent read the docs.

**Workflow**
1. **Docs digest.** A sub-agent read the getting-started page, the businesses/invoices/payouts guides, the 115k-character
   API reference and the webhook guide. It returned one structured brief: base URL, headers, endpoints per flow,
   the webhook signature algorithm, and a list of contradictions. That brief became `CLAUDE.md` and the first draft of `FEEDBACK.md`.
2. **Flow choice.** Invoices, because they need no on-chain step and have a clear lifecycle and webhook set.
3. **Code.** The agent wrote the client, the webhook handler, the flow and the tests in one pass. I reviewed it and steered the decisions:
   zero dependencies, separate receiver and flow processes, and refusing live keys.
4. **Verification.** Typecheck and 16 unit tests passed before any live call. The live run against the test API is described below.

**Where it saved time**
- Reading about 200k characters of docs and pulling out what matters, including cross-page contradictions I wouldn't have noticed in an hour.
- Boilerplate: typed client, raw-body webhook verification, and test scaffolding.
- Writing up feedback in a consistent format.

**Where it got things wrong / needed correction**
- _Updated after the live run (see below)._
- It couldn't render the Part 1 Word doc to check the layout, because LibreOffice wasn't installed.
  It said so instead of claiming the layout was fine.
- Inline `python -c` through Git Bash on Windows broke on quoting, so it switched to a script file.

### Live run notes
_Pending: results of `npm run flow` against the test environment._
