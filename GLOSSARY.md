# Glossary

Domain terms used in code, issues and docs. Use these names; avoid the listed synonyms.

**Invoice lifecycle**: The transitions an invoice goes through on Oncade: `draft → sent → (processing →) paid`, or
`draft | sent → cancelled`. It is also the name of the module (`src/invoice-lifecycle.ts`) that drives those transitions
and confirms each one. _Avoid_: invoice flow, invoice service.

**Confirmation**: The result of one lifecycle transition. It holds the invoice state as read back from the API (the source of
truth) plus what was observed on the webhook side: `received`, `timeout` or `skipped`. A missing webhook is an observation,
not a failure. A state mismatch is a failure (`InvoiceLifecycleError`). _Avoid_: ack, receipt.

**Event source**: Where the lifecycle reads verified webhook deliveries from. It has one operation:
`waitFor(match, { since, timeoutMs })`. Events received at or after `since` count, including ones that arrived before the
wait started. Adapters: the file event log (`.data/events.jsonl`, written by the webhook receiver) and in-memory (tests).
_Avoid_: event bus, queue.

**Effective scopes**: What an API key can actually do: the platform's `approvedScopes` ∩ the key's `activeScopes`. The
business grant narrows it further on the server, which the client can't see. Exposed as `platform().can(scope)`.
_Avoid_: permissions, active scopes (that's only the key's half).

**Platform identity**: The normalized result of `GET /v1/platform/me`: `platformId`, `environment`, `status` and effective scopes.
It hides the gap between the documented shape and the real response.
