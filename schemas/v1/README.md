# ANET v1 wire contract

These JSON Schema 2020-12 documents define the interoperable ANET v1 wire format. They describe the target contract, not every behavior of the current prototype.

## Normative rules

- Servers assign message `id`, `created_at`, and authenticated `from`.
- Cursors are opaque client values. Clients store and return them but never parse, compare, or construct them.
- Delivery is at-least-once. Consumers acknowledge explicitly after durable processing.
- Idempotency is scoped to authenticated sender plus `idempotency_key`.
- Long-poll timeout is a successful empty inbox response.
- Raw corrections, reflections, relationships, cursor state, and identity secrets are not public health data.
- All timestamps are UTC RFC 3339 with fixed millisecond precision.

See `tests/contract/state-transitions.md` for required behavioral transitions and known v1.1 prototype deviations.
