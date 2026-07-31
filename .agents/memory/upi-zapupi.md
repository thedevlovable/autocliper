---
name: ZapUPI UPI payments
description: Trust model and gotchas for the ZapUPI gateway integration (unsigned webhook, idempotent confirm)
---

# ZapUPI UPI payments

- Single credential: `ZAPUPI_ZAP_KEY` (their "zap_key"). API is form-encoded POSTs to pay.zapupi.com (create-order / order-status). No webhook signature exists.
- **Rule: the webhook body is a HINT, never proof.** Only the order_id (regex-gated) is read from it; payment state is always re-fetched from the gateway's order-status API server-side before any grant. Webhook always answers 200 so the gateway doesn't retry-flood.
- Confirm is idempotent under webhook + return-page-poll races: gateway status fetched BEFORE the row lock, then SELECT FOR UPDATE + terminal-state re-check inside the transaction; grant (same fns as admin manual approval) and the paid flip commit atomically.
- **Never grant on anomalies** — amount mismatch or gateway test-env payment hitting prod parks the order as `review` for the admin panel instead.
- Return page polls order status every few seconds; pending polls trigger the same confirm path, so payments activate even if the webhook never arrives.
- Billing catalog advertises UPI prices only when the key is configured → UI payment buttons appear automatically once the secret is saved; nothing else to flip.

**Why:** unsigned-webhook gateways make forged callbacks trivial; double-confirm + idempotent locked grant is the only safe pattern.
**How to apply:** any new payment provider without signed webhooks (or Stripe work building on this billing code) must keep the re-fetch-before-grant + row-lock shape.
