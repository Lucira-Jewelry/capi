# One-brand staging checklist: current status

**Latest follow-up:** [Current review](latest-readiness-review.md) supersedes the status below: 549 tests pass; the previously reported alternate-contact erasure and cached/concurrent pause findings are fixed and verified. Retention caching and public intake protection are implemented; cloud/platform verification is pending.

Reviewed 9 October 2026 against the current local files. Scope: Zoho store Purchase to Meta/Google; website bridge is optional. This supersedes earlier reports where they label the fixes below as absent. No cloud resources or application logic were changed during this review.

## Verification

- Latest follow-up on 9 October: type checking, `npm run build:release`, and the Docker image build passed. **477 tests passed across 43 files** with the emulator command below. The production container served `/health`, `/tracker.js`, and `/admin` with HTTP 200, ran as UID 1000, and exited with code 0 on SIGTERM. This smoke test used synthetic settings, sends off, and no real cloud or ad credentials; it did not exercise real Firestore.
- Production packaging is now complete locally: production start command, bundled server and assets, multi-stage Docker image, unsafe-production-config checks, Firestore index/TTL definitions and setup script. Cloud execution remains unverified.
- Type checking and both frontend builds passed.
- Initial full emulator run: 443 passed, one test exceeded the five-second timeout.
- Full rerun with four workers and a 15-second test timeout: **444 tests passed across 40 files**, none skipped. Command: `npm run test:emulator -- --maxWorkers=4 --minWorkers=1 --testTimeout=15000`.
- Synthetic repro of the earlier oversize-cookie case now produces a 2,192-byte cookie name/value, below the configured 3,800-byte cap.
- A 60-day-old touch for a 30-day tenant now returns `skipped: expired`.
- IPv4-mapped loopback recognition now returns blocked.
- Platform requests are mocked; this is not proof of live account acceptance, attribution, or cloud readiness. Existing emulator was reused and left running.

## Completed in code and covered locally

| Checklist item | Current evidence |
|---|---|
| Outbound-send switch | `OUTBOUND_SENDS` defaults off in normal startup; dispatcher enforces it before claiming/sending, covering scheduled and manual dispatch. |
| Pilot brand/platform restrictions | `SEND_ALLOWED_TENANTS` and `SEND_ALLOWED_DESTINATIONS` restrict sends. Blocked deliveries remain queued without consuming attempts/claims. UI explains blocked sending. |
| Extended disconnected waits | `SalesRepo.completeDelivery` resets completed claims to zero. Regression exercises more than 20 connection waits, then successful reconnect/send. Crash loops remain bounded. |
| Server-cookie byte cap | `sealWithinLimit` removes optional UTM data and older touches, caps serialized name/value to 3,800 bytes, rejects a single oversized touch. |
| Click retention at collector | `/touch` read/write and `/identify` cookie/browser input use tenant retention instead of the earlier fixed 400-day window. |
| Checker private-address protection | Mapped IPv6 and more special ranges are checked, connection uses checked DNS results through safe lookup, schemes/credentials are restricted, and local names require explicit development configuration. |
| CORS checker false positive | Preflight must succeed and allow POST/content-type; real POST must return matching origin/credential permission headers. |
| Tag text false positive | Checker examines script tags with the actual key, ignores HTML comments, and checks `data-endpoint` hostname. |
| Existing purchase pipeline | Zoho mapping, store-only eligibility, hash-only CRM customers without a website visit, replay protection, suppression, leases/retries, suspension, Meta test code, Google validate-only check and processing diagnostics remain covered. |
| Operator workflow | Setup check, preview, send-policy explanations and additional UI coverage are implemented. |

Important: `npm run dev` still explicitly defaults `OUTBOUND_SENDS=on`, emulator configuration, development secrets, and recurring dispatch. Do not use that script as the GCP launch command. Start staging with sends off, then allowlist only the intended tenant/destinations before enabling.

## Partial or unresolved code items

| Item | What remains | Impact for this pilot |
|---|---|---|
| Production deployment validation | Production packaging is now implemented and verified locally. Real Cloud Run startup, IAM, database indexes/TTL and queue queries are still untested. The guide intentionally omits required `PUBLIC_URL` on first deployment; replace this with a known HTTPS URL or validate and document the failing-deployment bootstrap. | Local packaging blocker resolved; cloud verification remains. |
| Data cleanup/erasure | `deletePerson` does not remove sale hashes or all related merged records. | Define and verify a staging cleanup procedure before real customer data. Synthetic-only trial can proceed once deployment is ready. |
| Tenant retention cache | Server caches each `Store` once. Ingestion/dispatch can initialize default retention before tenant settings arrive; edits do not rebuild it. | Current collector click filter is fixed, but full persisted-person retention is not. Use documented defaults for a narrow pilot or fix cache wiring. |
| Browser withdrawal after reload | Cookie clearing works; suppression still needs explicit contact because `lastContact` is memory-only. Failed notification is not retried. | Required if testing the website bridge. For Zoho-only customers, verify an explicit CRM/operator withdrawal procedure and dispatch suppression. |
| Checker completeness | Cookie-header check is not browser storage/read-back; tag check does not verify correct script `src`; same-site relationship is not established; real POST status is not included in the CORS pass predicate. | Follow-up hardening and actual browser smoke test for website pilot. Previous core false positives are fixed. |
| Auth and public intake | Admin/internal wrong-token attempts now have a per-instance limiter. Shared admin token remains; public identify/touch/consent/webhook intake has no general rate limiter. Verify proxy-hop handling in the deployed topology. | New auth protection is complete locally; constrain public traffic for the pilot. |
| Stop procedure | Deployment guide claims environment updates or pausing Scheduler stop sends immediately. Neither cancels in-flight requests or work already running on old instances. | Correct the runbook and test suspension/send-off with work in flight before enabling sends. |
| Google product coverage | One `UPLOAD_CLICKS` action per brand; not a complete Store Sales or customer-audience integration. | Confirm intended account/action for direct store purchases. Do not infer matching/bidding utility from HTTP acceptance. |

## Configuration and external evidence still needed

These are not marked done merely because the code supports them. The project is local; no cloud or account setup was inspected in this follow-up.

- [ ] Isolated staging GCP project and Firestore database with correct runtime identity.
- [ ] Managed secrets, stable encryption key, correct project and HTTPS public URL; emulator variables absent.
- [ ] Composite indexes ready on real Firestore and all six expiry collection groups configured.
- [ ] Reproducible deployed artifact boots and serves tracker/admin assets; real database queue queries work.
- [ ] Admin/internal access protection and authenticated Scheduler dispatch; keep interval zero and sends off until preflight passes.
- [ ] Brand-specific Zoho won/channel/contact/consent/order/time/value/currency mapping and restricted staging webhook verified with actual CRM records.
- [ ] Correct Meta dataset/token/test-event code, confirmed Google credentials/account/conversion action and appropriate nonbidding trial settings.
- [ ] Payload preview inspected; Meta Test Events receipt and Google validate-only success recorded.
- [ ] Deliberate permitted Google upload followed to processing success or explained rejection; platform attribution inspected separately.
- [ ] Monitoring for queue age, errors and processing rejection; tested send-off/suspend/reconnect/cleanup drill.
- [ ] If website bridge is included: brand DNS, certificate, Host/HTTPS forwarding, installed tag, browser consent/withdrawal and cookie read-back demonstrated.

## Recommendation

For direct Zoho store purchases, production packaging is now ready for a synthetic staging deployment. Resolve the deployment bootstrap and stop-procedure issues, then complete the cloud/account checklist with sends off. Configure one store-only Purchase tenant, use synthetic records and previews, and enable only the intended destination after preflight. A small real-customer batch follows only after consent and cleanup evidence.

Website AddToCart/checkout/payment ingestion, shared browser/server event IDs, website-specific Meta payloads, per-event Google action mapping, Shopify webhooks, and WhatsApp referral ingestion remain separate development work; this update does not implement those channels.

First-party cookie improvements are complete enough for further local testing; they do not establish deployed browser readiness. Missing website features are not blockers for a Zoho-only pilot.
