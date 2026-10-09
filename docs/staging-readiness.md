# Brand staging readiness — 9 October 2026

Current checklist status: [latest verification and completed fixes](checklist-status.md). Outbound-send controls, connection-wait claims, cookie sizing/retention and checker hardening described as missing below have since been implemented. The remainder of this document is an earlier assessment.

Latest follow-up: [first-party domain and setup-check review](first-party-review.md), including the current 359-test result, live DNS observation, and remaining checker/cookie issues. Earlier test counts below describe prior snapshots.

## Decision

**Do not deploy the current repo unchanged for a real-brand trial.** The application is close to a controlled, single-brand **store Purchase / CRM offline-conversion pilot**, after the deployment and safety gates below. It is not ready to demonstrate complete website ecommerce, website lead, WhatsApp, app, call, and Google Store Sales coverage.

Start with synthetic records in an isolated GCP staging project. Introduce consenting real customers only after the privacy, destination, and cleanup gates pass. This is a repository assessment: no GCP resource, brand permission, actual dataset, or live Google/Meta account was inspected or changed.

## Verified locally

### Subsequent first-party subdomain review

The repo now includes per-site `trackingHost`, brand-host script/endpoint generation, `/touch`, a signed host-only HttpOnly cookie, credentialed CORS, and merging cookie click IDs into `/identify`. These changes support the website-to-Zoho store attribution bridge. They do not change Zoho purchase ingestion or create a website conversion-event collector. The four targeted hostname, cookie, tracker, and HTTP suites passed **48 tests**; current type checking and frontend builds also passed. Actual brand DNS, TLS, proxy Host preservation, and browser cookie persistence have not been verified without the brand URLs.

Two additional first-party findings need attention: (1) there is no serialized server-cookie byte budget: a synthetic sequence of five valid `/touch` requests produced a 12,570-byte cookie name/value while returning HTTP 200, well above Chromium's 4,096-byte limit; compact/drop optional data and trim touches before signing; (2) cookie clicks are filtered at identify using a fixed 400-day window rather than tenant retention, and new clicks renew the cookie lifetime without pruning older clicks to tenant retention. Cookie clearing after reload now exists, but it still does not identify a previously stored customer for server suppression when contact is unavailable. Safari can cap cookies when it detects third-party CNAME/IP cloaking; a subdomain does not guarantee 90-day persistence. See [WebKit's policy](https://webkit.org/tracking-prevention/) and [Chromium cookie limits](https://chromium.googlesource.com/chromium/src/+/refs/heads/main/net/cookies/parsed_cookie.h).

The full-suite counts below refer to the preceding readiness review, before these additional tests were added.

- Full Firestore-emulator suite: **29 files, 277 tests passed**, none skipped.
- TypeScript check passed; tracker and operator-console builds passed.
- Platform HTTP in tests is mocked. Tests establish local behavior, not platform acceptance, attribution, matching quality, or live bidding impact.
- A separate synthetic browser probe reproduced withdrawal after reinitializing the tracker: `withdraw()` returned `{ notified: false }`; only `/identify` was requested, no `/consent` request.

## What is implemented

| Area | Ready to exercise in a constrained pilot | Boundary |
|---|---|---|
| Brand setup | Tenant settings, site keys/origin restrictions, encrypted connections, operator UI | Shared operator token; not brand-specific user access |
| Website-to-store bridge | Capture ad click IDs; identify consented phone/email; match later CRM sale | Tracker identifies; it does not collect a full website event funnel |
| Ingestion | Zoho won-deal webhook, generic webhook, CSV with dry run | Use one source and stable order/event IDs; validate real CRM mapping |
| Queue | Atomic sale/delivery writes, due-date queries, lease ownership, retries, suspension checks | Real Firestore indexes and long disconnected periods still need attention |
| Meta | Hashed contact, click matching, store `physical_store`, test-event code, response/trace diagnostics | Confirm dataset access and deployed API version; website payload is incomplete |
| Google | Data Manager v1 upload, OAuth or service-account key, validate-only connection check | One `UPLOAD_CLICKS` conversion action per brand; no event-specific action mapping |
| Google diagnostics | Persist request ID and reconcile asynchronous per-destination processing status | Accepted is not processed; processed is not attributed |
| Consent | Opt-in eligibility, server suppression, suppression check before dispatch | Browser withdrawal after reload/network failure is incomplete |
| Operator visibility | Sales, skips, errors, resend, Google processing diagnostics; allowlisted ingest logs | No demonstrated cloud alerts or end-to-end live monitoring |

## Gates before GCP deployment

| Priority | Required work | Evidence / acceptance |
|---|---|---|
| Blocker | Provide a reproducible production launch/build path | `package.json` has no `start`; `build` builds only browser/admin assets. Server/workspaces export TypeScript; `tsx` is a dev dependency. No application Dockerfile or complete deployment definition exists. Build a container or explicitly configure buildpacks, pin a supported Node version, include runtime dependencies and assets, and boot the built artifact locally without an emulator. |
| Blocker | Set a dedicated staging project, Firestore database, runtime identity, and secrets | Supply real `GOOGLE_CLOUD_PROJECT`, HTTPS `PUBLIC_URL`, random 32-byte `SECRETS_KEY`, strong `ADMIN_TOKEN`, and separate `INTERNAL_TOKEN`. Never use `npm run dev` in GCP: it defaults to emulator settings and development secrets. Ensure `FIRESTORE_EMULATOR_HOST` is absent. Persist the encryption key across revisions. |
| Blocker | Deploy Firestore indexes and retention policies | Deploy `infra/firestore/firestore.indexes.json`; wait for every index to be ready. Exercise pending, due retry, expired lease, and Google processing queries against real Firestore. Emulator tests do not prove index readiness. Enable `expiresAt` TTL for `persons`, `identities`, `touches`, `sales`, `deliveries`, and `ingest_log`; suppression records deliberately persist. The repo lacks a root Firebase deployment configuration. |
| Blocker | Control all outbound sends | No global `sendEnabled`/shadow gate exists. Disabling the interval/Scheduler does not disable manual admin dispatch. Prefer an enforced staging send gate/approved destination allowlist. Until then, use synthetic records only, restrict operators, configure Meta test mode, and keep automatic dispatch off. Google connection check is validate-only; ordinary dispatch is live ingestion. |
| Required | Protect operator/internal routes and limit public intake | Browser tracker and CRM webhooks need the relevant public routes. A shared bearer operator token exists, but there is no rate limiting or brand-specific login. Define admin/internal access protection without blocking website/webhook traffic; Origin checking is not authentication against scripted callers. Start with one operator and low traffic. |
| Required | Configure request-driven dispatch and basic cloud observability | Set `DISPATCH_INTERVAL_SECONDS=0`; schedule authenticated HTTP dispatch after preflight. Current internal route additionally requires `x-internal-token`; Cloud Scheduler OIDC alone does not satisfy it. Set request timeout/capacity for the pilot and alert on request failures, queue age, auth errors, and Google rejection/partial processing. `/health` checks process liveness only. |
| Required | Configure Google authentication actually supported by this code | Enable Data Manager API in the credential project. Grant the configured principal access to the brand's Google Ads account or manager. Current service-account auth requires a JSON private key; attaching a Cloud Run identity alone does not supply it. Use a mounted managed secret via `GOOGLE_SERVICE_ACCOUNT_FILE`, or configured OAuth credentials and brand refresh token. Confirm account/action ownership and run Check connection. |

Cloud Run supports both containers and source deployments; a Dockerfile itself is not mandatory. The missing reproducible server launch/runtime configuration is the blocker. See [Node buildpacks](https://docs.cloud.google.com/docs/buildpacks/nodejs), [Cloud Run secrets](https://docs.cloud.google.com/run/docs/configuring/services/secrets), and [Scheduler invocation](https://docs.cloud.google.com/run/docs/triggering/using-scheduler). Google authentication and destination setup: [Data Manager access](https://developers.google.com/data-manager/api/devguides/quickstart/set-up-access) and [offline event upload](https://developers.google.com/data-manager/api/devguides/events/google-ads/offline/send-events).

## Code issues before real-customer testing

1. **Withdrawal after navigation/reload and network failure.** `packages/tracker/src/tracker.ts` stores `lastContact` only in memory. A later page cannot notify the server unless contact is supplied explicitly. Failed notification is not retried, and `setConsent(false)` discards the result. Also test interaction with the CMP hook, which takes precedence over manual state. Implement a reliable withdrawal integration with a stable privacy-preserving identity or explicit contact and acknowledged retry behavior. For a tightly scoped pilot, a brand/backend integration may explicitly provide contact and verify server suppression; a generic cookie-banner call alone is insufficient. Test withdrawal after identification, after reload, during a failed request, and after queueing a sale.
2. **Disconnected deliveries eventually fail.** `packages/senders/src/dispatcher.ts` checks `MAX_CLAIMS=20` before the disconnected branch. Waiting does not increment send attempts but does consume claims. At 15-minute waits a continuously disconnected sale reaches failure around five hours later. Do not describe this as indefinite waiting. Separate legitimate connection waits from worker-crash exhaustion; test reconnecting after more than 20 scheduled runs. Connecting accounts before ingestion is a limited pilot workaround.
3. **Retention depends on which endpoint runs first.** `packages/server/src/main.ts` caches a `Store` per tenant indefinitely. Dispatch/ingestion can initialize it with the 90-day default before identify supplies tenant settings. Later tenant retention changes do not refresh it. Resolve configuration caching before promising custom retention. Default 90-day identity retention avoids this particular discrepancy for the initial pilot; sales still default to 400 days and ingest logs to 30.
4. **Erasure is incomplete.** `Store.deletePerson()` deletes that person's touches and identity mappings, but not persisted sale hashes or all linked/merged records. Agree on and verify a staged-data cleanup process before introducing real customer data. Firestore TTL is eventual cleanup, not an immediate erasure mechanism.
5. **Keep event coverage narrow.** Google sends every event to one conversion action. Meta maps `online`/`web_lead` to `system_generated`, not a complete website CAPI payload. Tracker has no conversion-event API, and browser/server event-ID coordination, browser URL/UA/IP/`fbp`, item data, and refund/adjustment workflows are absent. Do not enable these channels for the initial store pilot. `IN_STORE` on an offline click-import event is not proof of Google Store Sales product support.

Additional follow-ups before broad rollout: canonical deduplication across sources, merged-person touch selection, date/window validation (including future timestamps), tenant-aware rate limits, stronger per-brand access, and keyless Google authentication. API versions and lookback-window assumptions marked `VERIFY` in source must be checked for the target accounts; local tests do not validate them.

## Proposed first-brand configuration

- One isolated staging tenant; `allowedChannels: ['store']`; opt-in consent only; one source of sales; one `Purchase` event type.
- Default 90-day identity retention until cache behavior is fixed, with explicit understanding of separate sales/log retention and verified cleanup.
- Brand staging website origin explicitly allowlisted; synthetic contact records initially. Use fresh timestamps and unique stable event/order IDs.
- Meta staging/test dataset with a valid test event code, confirmed access, and confirmed supported API version.
- Google conversion action owned by the receiving account, appropriate for `UPLOAD_CLICKS`, configured as secondary and excluded from bidding goals as confirmed in the account. Validate-only first; any normal Google dispatch is a deliberate live upload, not a sandbox equivalent to Meta test events.
- No historical backfill, mixed lead/purchase actions, multiple sales sources, or automatic recurring sends until acceptance checks pass.

## Acceptance sequence and evidence to retain

1. **Cloud boot:** production artifact boots with `PORT`; `/health`, `/tracker.js`, and `/admin` load; Firestore writes and all queue queries work; missing secrets fail startup; browser requests use HTTPS staging URL. Do not treat `/health` alone as readiness.
2. **Isolation/access:** wrong admin/internal/webhook tokens fail; unapproved site origin fails; suspended tenant cannot import or dispatch; no staging write appears in production Firestore. Confirm exact destination IDs before enabling sends.
3. **Capture → CRM → queue:** consented synthetic ad click identifies; later consented store Purchase links to it; value/currency/time/source/channel are correct; replaying the same source/event ID creates no second delivery. Test email and phone formats separately; resolve any merged identities before the real pilot.
4. **Negative cases:** denied/unknown consent in opt-in mode skips; disallowed channel skips; withdrawal suppresses queued and subsequent events; disconnected/reconnected account and expired worker lease behave correctly. Run real-database lease contention with two workers.
5. **Platform preflight:** Google Check connection succeeds with validation only. Meta receives the sample in Events Manager Test Events with expected fields. Capture request/trace IDs and error messages, excluding secrets/customer identifiers from shared evidence.
6. **Google controlled upload:** after explicit account-side confirmation, upload a permitted sample to the secondary conversion action. Record request ID, poll until processing success or explained rejection/partial success, then inspect account diagnostics. Fake click IDs may validate a request shape but cannot prove ad attribution; matching/attribution requires eligible real, consented ad interactions.
7. **Operational trial:** introduce a small agreed batch of real consenting store sales only after the preceding privacy gates. Run Scheduler, compare source orders to queued/accepted/processed totals, test retry/reconnect, and observe through at least one Google reconciliation cycle (first check is scheduled after 30 minutes; processing can take longer).
8. **Stop/cleanup drill:** disable scheduling and manual sending controls, suspend tenant, revoke staging access if needed, verify no further outbound events, and execute the agreed data cleanup. Already accepted platform events are not undone by suspension.

**Go for a controlled brand pilot only when these gates have recorded evidence.** The current green local suite makes that pilot plausible; it does not make the current repository deployment-ready or establish broad conversion coverage.
