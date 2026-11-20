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
| `src/invoice-lifecycle.ts` | **Invoice lifecycle** module: `issue()`, `send()` and `cancel()` each return a **Confirmation** (API read-back + webhook `received`/`timeout`/`skipped`); a state mismatch throws |
| `src/webhook-inbox.ts` | **Webhook inbox**: stores each verified delivery exactly once (`record` → new/duplicate, marked seen only after a successful write) and serves stored deliveries as an Event source. Adapters: `FileInbox` and `InMemoryInbox`, both run against one contract suite |
| `src/event-source.ts` | **Event source** interface: the read side the Invoice lifecycle depends on |
| `src/client.ts` | Typed client: auth, API version, `X-Target-Business-Id`, automatic UUID `Idempotency-Key` on POST/PUT/PATCH, typed errors, redacted debug logging. `platform()` normalizes `/me` into **Platform identity** with `can(scope)`. The constructor refuses non-test keys |
| `src/webhooks.ts` | HMAC-SHA256 verification over the **raw body** with a constant-time compare. The http handler stores first and reacts later: 401 bad sig, 400 bad JSON, 200 once stored or duplicate, 500 only if storing fails (so Oncade retries); `afterRecord` runs after the response |
| `src/server.ts` | Webhook receiver on `:3001/webhooks/oncade` (`WEBHOOK_PORT`), stores deliveries in a `FileInbox` (`.data/events.jsonl`); `/health` identifies itself |
| `src/flow.ts` | The end-to-end demo, presentation only. It provisions the business, checks whether the receiver is up, and prints each Confirmation |
| `src/idempotency-check.ts` | Sends the same `Idempotency-Key` three times to see whether the API dedupes. Found FEEDBACK #10 |
| `src/tunnel.ts` | Starts a `cloudflared` quick tunnel on `WEBHOOK_PORT` and prints the URL to paste in the portal |
| `src/selftest.ts` | Sends valid, replayed, wrong-secret and unsigned deliveries to the local receiver |
| `scripts/metrics.cjs` | `npm run metrics`: cohesion (LCOM4 per class) and coupling (Martin's Ca, Ce, I, A, D per module), with a verdict per module |
| `docs/adr/` | Architecture decisions. ADR-0001 explains why `client.ts` and `config.ts` stay in the zone of pain |
| `test/` | `node:test` suites at module interfaces: Invoice lifecycle (fake Oncade behind the fetch seam + in-memory Event source), Event source adapters, Platform identity, webhook verification and handler, client headers |
| `GLOSSARY.md` | Domain terms used in code and issues |
| `FEEDBACK.md` | Part 2 feedback: doc bugs and confusion found while building |
| `CLAUDE.md` | The context file the AI agent worked from: API facts, verified deviations from the docs, guardrails, and agent skills config |
| `docs/agents/` | Agent skill configuration: issue tracker (GitHub), triage labels, domain-docs layout |

Safety: `config.ts` refuses any key that isn't `oncade_platform_test_…`.

## Run it

Requirements: Node ≥ 20.6, plus [`cloudflared`](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) for a public webhook URL (no account needed).

```bash
npm install
cp .env.example .env          # fill ONCADE_API_KEY, ONCADE_WEBHOOK_SECRET, BUSINESS_OWNER_EMAIL
npm test                      # offline unit tests

# terminal 1 - webhook receiver
npm run webhooks
# terminal 2 - public tunnel; prints the full webhook URL to paste
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

**Agent setup (committed so it's reusable)**
- **`CLAUDE.md` is a living context file.** It started as the docs digest. It then gained a "Verified against the live test
  API" section, so the next agent session trusts real responses over the docs. It also holds hard rules: test keys only,
  never commit or print secrets, zero runtime dependencies, typecheck and tests before every commit.
- **Agent skills** ([mattpocock/skills](https://github.com/mattpocock/skills)) are configured in `docs/agents/`:
  - Issues go to this repo's GitHub Issues.
  - A triage label vocabulary was created on GitHub: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human` and `wontfix`.
  - Domain docs use a single-context layout (`GLOSSARY.md` plus `docs/adr/`, created when a term or decision is settled).

  With this in place, skills like `to-spec`, `to-tickets`, `triage`, `tdd` and `diagnosing-bugs` can turn the FEEDBACK items
  into issues and work them. `ready-for-agent` marks the ones an unattended agent can pick up.
- **Guardrails in the harness, too.** Claude Code's auto mode let the agent work freely inside the repo, but it stopped
  outward-facing actions such as creating a public repo on my account. Secrets were never pasted into chat. The agent checked
  whether `.env` was filled without printing it, and checked before every commit that `.env` wasn't staged.

**Where it saved time**
- Reading about 200k characters of docs and pulling out what matters, including cross-page contradictions I wouldn't have noticed in an hour.
- Boilerplate: typed client, raw-body webhook verification, and test scaffolding.
- Writing up feedback in a consistent format.

**Where it got things wrong / needed correction**

Most of the AI's mistakes came from trusting the docs. The live run caught each of them:
- **`/me` shape.** It read `activeScopes` from the top level, as documented. The API returns it under `keyInfo`, so the
  business would have been created with an empty `grantScopes`. Fixed to use `keyInfo.activeScopes ∩ approvedScopes`.
- **Idempotency key format.** It generated `invoice-<uuid>` keys, which the API rejects (400, UUID only). Fixed, and
  the client now validates before sending.
- **Over-defensive webhook matching.** The docs say invoice events carry no data, so it wrote a deep search for the
  invoice id anywhere in the payload. The real payload has a plain `invoiceId`. Harmless, but more complicated than needed.
- **Port 3000 default** clashed with another local app. Moved to 3001 and made the tunnel follow `WEBHOOK_PORT`.
- **What it got right:** HMAC verification over the raw body worked on the first live delivery.

**Architecture pass ([#1](https://github.com/snow-sam/oncade-platform-poc/issues/1)).** After the PoC worked, I ran the
`improve-codebase-architecture` skill. It produced an HTML report with four deepening candidates. I picked the top one, and a
`grilling` session settled 15 design decisions before any code was written: what counts as confirmed, where the seams go,
what stays out of the module, and the test strategy. The decisions went into a GitHub issue. The implementation was test-first:
red, then green, at the module interfaces. It was verified live on both paths (receiver up: all webhooks `received`;
receiver down: `skipped`, still confirmed by the API). Result: the most fragile logic moved out of an untested script into
the Invoice lifecycle module, which has 10 interface tests. The `/me` drift now lives in one place (`client.platform()`), and a
docs-driven helper (`payloadMentions`) was deleted.
**Second architecture pass ([#2](https://github.com/snow-sam/oncade-platform-poc/issues/2)).** Re-reading the webhook
code for candidate #3 surfaced a real bug that the original tests missed. The handler marked a delivery as seen *before*
processing it. If processing failed, it answered 500 so Oncade would retry, but the retry was then acknowledged as a duplicate
and the event was lost. The live run had just shown that Oncade does retry, about 60s later. The fix was structural: a
**Webhook inbox** module that stores first and marks seen only after a successful write, with reactions moved after the
response. Four shallow classes (two dedupe stores, two event sources) became two adapters of one module. A regression test
replays a delivery whose first store failed.

**Metrics pass ([#3](https://github.com/snow-sam/oncade-platform-poc/issues/3)).** I asked for a cohesion and coupling
review using LCOM and Martin's metrics. No skill computes these, so the agent wrote `scripts/metrics.cjs` on the
TypeScript compiler API. A short grilling session settled how to read the numbers. Martin's metrics were designed for
packages, so the unit is a file and only production imports count. Abstractness counts only behavioural contracts,
because counting DTO interfaces would make `types.ts` look abstract. A high D only needs action when a module that isn't
an entry point depends on a volatile, concrete one.

- Cohesion: LCOM4 = 1 for every class that has methods (the two error classes only hold fields), so nothing changed. LCOM-HS is high for `OncadeClient` and `FileInbox`, but that
  comes from the metric (one shared field, one private helper), not from a design problem.
- Coupling: two edges were real problems and were removed. Neither change alters behaviour, and the 42 tests stayed green.

| Module | Before (Ca/Ce · I · D_b) | After | Change |
|---|---|---|---|
| `invoice-lifecycle.ts` | 1/3 · 0.75 · 0.25 | 1/2 · 0.67 · **0.17** | declares its own `InvoiceApi` (the 4 methods it uses) and no longer imports `client.ts` |
| `webhook-inbox.ts` | 3/3 · 0.50 · 0.17 | 3/2 · 0.40 · 0.27 | `FileInbox` takes its file from the caller and no longer imports `config.ts`. D_b went *up* (fewer outgoing deps, so less unstable) but stays under 0.3. The point was the edge, not the number |
| `client.ts` | 4/1 · 0.20 · 0.80 `REVIEW` | 3/1 · 0.25 · 0.75 | accepted: only entry points depend on it now (ADR-0001) |
| `config.ts` | 6/0 · 0.00 · 1.00 `REVIEW` | 5/0 · 0.00 · 1.00 | accepted: only entry points depend on it now (ADR-0001) |

The agent deliberately did *not* add a single-adapter `OncadeApi` interface just to raise `A`. That would improve the
number and add an indirection with nothing behind it. ADR-0001 records when to revisit, and the script checks the ADR's
conditions instead of trusting a fixed list. Run on the "before" commit, it flags exactly the two edges that were removed.

A `/code-review` pass (Standards and Spec axes, run in parallel sub-agents) then caught bugs in the metrics script itself:
- An interface extending a DTO was counted as a contract, which understated `webhook-inbox`'s distance.
- The ADR exemption was a fixed list that never checked its own condition.
- An n/a distance printed as `ok`.

They were fixed, and the table above uses the corrected script.

One more AI slip, caught during the first pass's live check: to simulate "receiver down" it picked port 3999, where another local app
answered 200 on `/health`, so the flow treated it as the receiver. The fix was making `/health` identify itself rather than trusting any 200.

Tooling friction: Claude Code's auto-mode guardrail blocked the agent from creating a *public* GitHub repo on my account.
I ran that one command myself, which is a reasonable default. Two environment issues on Windows: it couldn't render the Part 1
Word doc (no LibreOffice), and it said so instead of claiming the layout was fine. Inline `python -c` broke on Git Bash quoting.

**Where the human mattered:** choosing the flow, creating keys, scopes and the webhook URL in the portal, and deciding to probe
idempotency. That probe found the most serious bug (FEEDBACK #10), which the docs would never have revealed.

### Live run notes (test environment, 2026-11-19)

```
[1] GET /me              ✓ env=test, platform status "pending", 17 effective scopes
[2] POST /business       ✓ grant active with 7 business/invoice scopes
[3] GET /readiness       ✓ ready=true (payoutWallet, address, kybVerification all "complete")
[4] POST /invoices       ✓ draft INV-2026-7217833, $60 + $0.30 payer fee   → webhook Platform.Invoice.Created ✓
[5] POST /:id/send       ✓ sent, emailSuppressed=true                      → webhook Platform.Invoice.Sent ✓
[6] GET /invoices/:id    ✓ status=sent, externalMetadata round-trips
[7] POST /:id/cancel     ✓ cancelled                                       → webhook Platform.Invoice.Cancelled ✓
```

`npm run idempotency:check`: the same `Idempotency-Key` sent 3× created **3 invoices**, so the key isn't enforced (see FEEDBACK #10).
`npm run webhook:selftest`: valid → 200, replay → 200 duplicate, wrong secret → 401, unsigned → 401.

Not covered: `Platform.Invoice.Paid`. Paying needs ACH on the hosted page. `npm run flow -- --keep` leaves an invoice in
`sent` and prints the pay link if you want to try it.
