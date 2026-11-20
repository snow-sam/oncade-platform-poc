# ADR-0001: Accept `client.ts` and `config.ts` in the zone of pain

Date: 2026-11-19 · Status: accepted · Issue: [#3](https://github.com/snow-sam/oncade-platform-poc/issues/3)

## Context

`npm run metrics` measures Martin's metrics per `src/` file (production imports only), using a behavioural
abstractness (`A_b`: interfaces with methods and abstract classes count; DTOs, type aliases and errors don't). The target
is a distance from the main sequence `D_b ≤ 0.3`, and LCOM4 = 1 per class.

Two modules are stable and concrete, so their `D_b` is high:

| Module | Ca | Ce | I | A_b | D_b | Who depends on it |
|---|---|---|---|---|---|---|
| `client.ts` | 3 | 1 | 0.25 | 0 | 0.75 | `flow`, `whoami`, `idempotency-check` |
| `config.ts` | 5 | 0 | 0.00 | 0 | 1.00 | `flow`, `server`, `whoami`, `selftest`, `idempotency-check` |

Every remaining dependent is an entry point, i.e. a composition root: it constructs the concrete client or reads the env.
The non-root edges were removed in #3. `invoice-lifecycle` now declares its own `InvoiceApi`, and `FileInbox` takes
its file from the caller.

## Decision

Accept both modules in the zone of pain while only composition roots depend on them. Don't add an `OncadeApi` interface
(or a config interface) just to raise `A`. It would have one adapter, so it would be a hypothetical seam. The test seam
for Oncade is already `fetch` (`fetchImpl`), which exercises the real client.

`event-source.ts` (`D_b` 0.33) is also accepted. It is a pure contract (`A_b` = 1), and its distance comes only from
importing DTOs from `types.ts`.

## Revisit when

- A module that isn't an entry point imports `client.ts` or `config.ts`. Give it a port it owns, as `InvoiceApi` does.
- A second Oncade adapter appears (e.g. a recorded-responses client). Then an `OncadeApi` interface is a real seam.

`scripts/metrics.cjs` prints `REVIEW` for any module over the threshold that this ADR doesn't cover.
