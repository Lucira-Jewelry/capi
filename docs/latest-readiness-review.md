# Latest follow-up: erasure and pause fixes verified

Reviewed 9 October 2026. Scope: one brand, Zoho store Purchase to Meta/Google. No cloud deployment or live ad sending was performed. Application code was not changed during this review.

## Verification

- Type checking and `npm run build:release` passed.
- **549 tests passed across 46 files**, none skipped, using `npm run test:emulator -- --maxWorkers=4 --minWorkers=1 --testTimeout=15000`.
- Reused the existing emulator and left it running. Platform requests in the suite are mocked.
- The exact previous synthetic CRM-only erasure repro now returns `emailSuppressed: true`; subsequent email-only Meta and Google deliveries are `skipped: consent_withdrawn`. Its tenant data was deleted after the check.

## What changed

| Earlier item | Current assessment |
|---|---|
| Customer erasure | Previous alternate-contact repro fixed: linked contacts are discovered through profiles, aliases and sales, then suppressed before deletion/anonymization. Phone-to-email and email-to-phone regressions pass. Operator withdrawal uses the same discovery. |
| Tenant retention cache | Fixed for subsequent writes: cache is keyed by tenant and retention; webhook/import/withdraw/erase receive tenant retention. Existing stored expiry dates are not retroactively rewritten by this change. |
| Deployment bootstrap | Guide now explains setting the deterministic HTTPS service URL before first deploy. The main deploy block still omits `PUBLIC_URL`; its definition and the instruction to add it appear after the command. Move these before the command and include the variable directly. |
| Stop procedure | Previous cached/concurrent-worker finding fixed: final send gate uses a fresh database read; all production dispatch entry points share a SerialQueue per instance. Documentation accounts for sends whose final check precedes pause and for multiple/old instances. |
| Public intake | Per-address browser/webhook budgets and wrong-webhook-secret lockout are implemented. Limits are per instance; deployed proxy-header behavior remains unverified. |
| Cloud/platform evidence | Still pending: Cloud Run, IAM/secrets, real Firestore indexes/TTL, actual Zoho mapping/webhook, Meta receipt and Google processing. |

The deterministic URL format in the updated guide agrees with [Google's HTTPS invocation documentation](https://docs.cloud.google.com/run/docs/triggering/https-request). Production config validates URL syntax, HTTPS and local-host exclusions; it does not prove that the configured hostname belongs to this service.

## Previously reported findings: resolved

### Alternate-contact suppression

Synthetic CRM-only repro: record a store purchase with both phone and email, erase using the phone, then ingest a new purchase containing only that email. The email is now suppressed and both new deliveries are skipped for consent withdrawal.

`linkedIdentity` discovers contacts through website profiles and related sales; `eraseCustomer` suppresses those contacts before clearing profile and sale data. Tests cover the reverse contact direction, contact chains, suppression-before-clearing, a new purchase during erasure, and refusal when the linked group exceeds the contact-count bound.

This verification closes the specific previously reproduced gap; it is not a claim that every possible identity graph or concurrent mutation has been exhaustively tested.

### Cached pause checks and concurrent dispatch

`SendControl.get({ fresh: true })` bypasses cached state. Production wiring uses it through `sendGate`; the dispatcher checks the gate after loading the connection and before calling either platform sender. A blocked delivery is returned to the queue without consuming an attempt. All production dispatch requests share a SerialQueue, preventing simultaneous dispatch runs on one instance.

Fresh-read, final-gate, pause-during-send, resume, and serial-concurrency tests pass. A send whose final check precedes pause can still complete; multiple instances and old revisions remain relevant. Actual Cloud Run timing and drain behavior remain unverified.

## Recommendation

The two previously reported local findings are closed. Ready to proceed with a synthetic-data staging deployment after tidying the bootstrap command. Start with sends off and complete cloud/account checks before outbound tests or real-customer batches. Website commerce and expanded WhatsApp ingestion remain outside this Zoho-only pilot.
