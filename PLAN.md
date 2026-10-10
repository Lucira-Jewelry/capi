# Conversion Tracking Platform: Full Plan

Status: draft v1. Companion to `SPEC.md` (detailed schema, matching rules, sender payloads). Where the two differ, this plan reflects the latest decisions (sGTM + Firestore for Phase 1, store only after identification).

Items marked **VERIFY** rest on API rules or prices recalled from memory and must be checked against current Meta, Google and GCP documentation before they are relied on.

---

## 1. Goal

Send sales that ad platforms cannot see on their own (store sales, WhatsApp-driven sales, delayed online sales) back to **Meta** and **Google Ads**, with click IDs where we have them and hashed phone/email otherwise, so ad spend is credited correctly.

- **This is a multi-tenant product to sell to many brands, in the space of Datahash and Stape**, aimed especially at CRM-first and offline-first businesses (jewellery, real estate, education, clinics).
- **Lucira Jewellery is the first customer and pilot**, not the shape of the product (store sales from Zoho CRM; online sales stay with the existing Shopify apps).

### Product principles
- **No brand-specific code.** Everything that differs between brands is configuration stored in the database (`TenantConfig`): consent policy, allowed channels, destinations, default country, retention, and per-source field mappings. Brands are onboarded with `scripts/create-tenant.ts` (later an admin UI), with no deploy.
- **Every source is an adapter** that produces one standard sale (Zoho today; generic webhook now; Shopify, HubSpot, WhatsApp later). The pipeline after the adapter is shared.
- **Per-brand secrets and keys:** public site keys for the website script (with allowed origins), a webhook secret per brand (only its hash is stored), and per-brand ad-platform credentials in Secret Manager (Part 4).
- **Tenant isolation** by namespace today (`tenants/{id}/...`); per-brand Firestore databases are an option when stronger isolation is needed.
- **Safe defaults for new brands:** opt-in consent, offline channels only (online excluded to avoid double counting), 90-day retention.

## 2. Decisions so far

| Topic | Decision |
|---|---|
| Edge / capture | **sGTM** (server-side GTM) on Cloud Run behind the brand's CNAME |
| Identity store | **Firestore**, keyed by hashed phone/email, TTL about 90 days |
| Logs and reports | **BigQuery**, dashboards in Looker Studio first |
| Anonymous visitors | Click IDs stay in the visitor's browser (cookie plus localStorage). **Nothing is stored on our servers until the person identifies** (phone or email) |
| Google Ads auth | OAuth through our Google Cloud project. Developer tokens are no longer required. Start on **Explorer** access (2,880 production operations/day) and upgrade to Basic when adding brands |
| Meta auth | Brand pastes a CAPI access token per dataset for the pilot. OAuth ("Connect with Facebook") comes later |
| Dedup | Always send our own stable ID: `event_id` (Meta), `order_id` (Google). Avoid overlap with other systems using the channel filter |
| Postgres | **Not in Phase 1.** Added in Phase 3 for the multi-tenant control plane |
| Build approach | Build and test locally first (Docker, Firebase emulator), then a small GCP dev project, then Lucira in shadow mode |

## 3. How it works end to end

```
Ad click → brand.com/?gclid=…/fbclid=…
   │  tracker.js stores click IDs + click time in cookie/localStorage (nothing sent to us)
   ▼
Visitor identifies (form, WhatsApp, login, checkout, billing counter)
   │  tracker.js posts hashed phone/email + stored touches → track.brand.com/identify
   ▼
Collector service (Cloud Run, our code: packages/server) → consent check → Store.identify (transaction)
   │   identities/{key} → person (merged if a phone and an email were two records)
   │   persons/{id}/touches/{touch_id} → click IDs, original click time
   │   (plain phone/email is hashed per platform, then discarded)
   ▼
Later: a sale (Zoho deal Won / Shopify order / WhatsApp)
   │  webhook → sGTM client → lookup hashed phone/email in Firestore
   ▼
Pick most recent touch before the sale → send:
   Meta CAPI  (physical_store / business_messaging / website; ph, em, fbc, event_id)
   Google Ads (uploadClickConversions with gclid, else enhanced conversions; order_id)
   │
   ▼
Logs → BigQuery → Looker Studio (delivery status, match rate)
```

Phase 2 inserts our own **Sender API** between sGTM and the platforms for retries, per-brand credentials, consent checks and a proper delivery log.

## 4. Tech stack

### Phase 1 (sGTM + Firestore)

| Layer | Choice |
|---|---|
| Cloud | GCP, separate dev and prod projects |
| Capture script | TypeScript, esbuild, served from a CDN |
| Shopify capture | Shopify Web Pixel |
| Edge | sGTM (Google's server container image) on Cloud Run |
| DNS / TLS | Brand CNAME to the Cloud Run domain mapping or a load balancer |
| Tags | Meta CAPI tag, Google Ads / offline conversion tag, Firestore Writer tag, Firestore Lookup variable |
| CRM ingestion | Custom sGTM client template for Zoho webhooks; Cloud Function or Cloud Run job for the daily sync |
| Identity store | Firestore, TTL policies |
| Logs / reports | BigQuery via Cloud Logging sink; Looker Studio |
| Retries | Cloud Tasks or Pub/Sub |
| Secrets | Secret Manager |
| Infra as code | Terraform, plus GTM API scripts for onboarding a new brand |
| Languages | TypeScript throughout, plus sGTM sandboxed JavaScript for templates |
| Local dev | Docker Compose (sGTM image), Firebase Emulator Suite, Node scripts that replay sample events |
| Tests | Vitest or Jest for hashing, phone normalisation, matching and age rules |
| Monitoring | Cloud Monitoring alerts, Sentry for the script |

### Added in Phase 2–3

| Layer | Choice |
|---|---|
| Control plane API | TypeScript service on Cloud Run (Sender API: queue, retries, idempotency, consent) |
| Database | PostgreSQL (Cloud SQL) for tenants, users, connections, billing |
| Admin app | Next.js with auth, org and roles |
| OAuth | Meta, Google Ads and Zoho connection flows; tokens in Secret Manager |
| Billing | Stripe, metered by events sent |
| Own collector | Thin Cloud Run service replacing sGTM when scale demands it |

## 5. What the brand provides vs what we provide

| We provide | Brand provides |
|---|---|
| `tracker.js` and Shopify pixel | Script installation (tag or GTM) |
| Collector / sGTM, cookie server, certificate | One CNAME (`track.brand.com`) |
| Hashing, matching, consent gate, senders | Forms that collect phone or email |
| Delivery logs and reports | Consent banner, privacy policy and in-store consent wording (with their legal advisor) |
| | Access to Meta, Google Ads and CRM accounts |
| | Confirmation of existing integrations (to avoid double counting) |

Website checklist for brands: install on every page including landing pages; cover the checkout domain if different; do not strip `gclid`/`fbclid`/UTM in redirects; add the CNAME; route every phone/email form through `tracker.identify`; connect the consent banner to the script.

## 6. Plan by part

### Part 0: Setup and verification (days 1–3)
- Create GCP dev project, enable APIs (Cloud Run, Firestore, BigQuery, Secret Manager, Cloud Tasks, Google Ads API).
- Confirm Google Ads API Explorer access is active; test one offline click conversion upload on a Lucira test account (**VERIFY** that offline uploads are allowed and how operations are counted).
- Confirm Meta dataset, generate a CAPI token, and open Events Manager Test Events.
- Collect the pilot brand's (Lucira's) Zoho field list (phone, email, amount, store, sale channel, deal ID, consent) and save it as that tenant's mapping. Repeat for every new brand during onboarding.
- List existing integrations that report conversions today (Shopify Meta and Google apps, Zoho integrations).
- **Exit:** access confirmed, field list agreed, one test conversion visible in each platform.

### Part 1: Local foundation (about 1 week)
- Repo layout: `tracker/`, `sgtm/`, `functions/`, `infra/`, `scripts/`, `docs/`.
- Docker Compose: sGTM image, Firestore emulator.
- Shared library: phone normalisation (E.164, default +91), email normalisation, SHA-256 hashing, consent evaluation, touch selection, per-destination age checks.
- Unit tests for all of the above.
- Sample event replay scripts.
- **Exit:** `npm test` passes; replayed events reach a local sGTM and write to the emulator.

### Part 2: Capture and identity (about 1 week)
- `tracker.js`: read click IDs and UTMs, build `fbc` (`fb.1.<click_ms>.<fbclid>`) and read `_fbp`, store touches client-side (first and latest), expose `identify()` and auto-bind forms, honour consent signals.
- Shopify Web Pixel equivalent.
- `/identify` is handled by our own small collector service (`packages/server`), not by an sGTM Firestore Writer tag: merging two people when a phone and email turn out to be the same person needs a transaction, which the tag cannot do. sGTM keeps the CRM webhook client and the Meta/Google tags and reads the same Firestore data. The browser sends plain phone/email over HTTPS; the server hashes per platform and stores only hashes.
- Status: **built and tested locally** (`packages/core`, `store`, `tracker`, `server`; 74 tests passing against the Firestore emulator).
- Firestore data model, TTL, security rules, indexes.
- **Exit:** a test click followed by a form submit produces the right Firestore documents locally.

### Part 3: CRM ingestion (about 1 week)
- sGTM client for the Zoho "deal Won" webhook; secret validation; raw payload logging.
- Field mapping and channel filter (store sales only; skip online orders).
- Daily sync job against Zoho (zoho.in data centre) to catch missed webhooks.
- Idempotency on deal ID.
- **Exit:** a sample Zoho payload produces a normalised store-sale event.
- Status: **built and tested locally** (`packages/ingest`, `/webhooks/{tenantId}/{zoho|generic}` in `packages/server`; 120 tests passing). Design: every source is an adapter that produces one `IncomingSale`; the pipeline (person lookup, consent, `evaluateDelivery`) is shared. The Zoho adapter is config-driven (`ZohoMapping`) and starts from `DEFAULT_ZOHO_MAPPING` (common field names) and each brand's real Zoho API names are saved as that tenant's mapping (`TenantRegistry.setSourceMapping`), never in code. Tenants, site keys and webhook secrets live in Firestore (`TenantRegistry`, 60 s cache); 132 tests pass, including two brands with different mappings, currencies, consent policies and destinations running side by side. Sales and per-destination deliveries are stored as `pending` or `skipped` (with reason); nothing is sent yet. The daily sync client (`ZohoClient`, COQL) is written from memory of Zoho's API: **VERIFY** before use.
- Decision for Part 4: our own service sends to Meta CAPI and the Google Ads API directly, instead of passing sales to sGTM tags, for retries, an audit trail and control of hashing.

### Part 4: Senders, admin API and admin UI
- Status: **built and tested locally** (188 tests; UI exercised in a real browser). See `README.md` for how to run it and what is left before real traffic.
- Built: per-brand encrypted connections (`SecretBox`, AES-256-GCM); Meta CAPI and Google Ads senders with error classification (retry, fail, or "needs attention" for rejected tokens); a dispatcher with claims and leases, retry schedule (1, 5, 30 min, 2 h, 6 h, then failed), re-check of the platform age window before every try, "not connected yet" waiting that does not use up attempts, and the same event ID on every try; admin API (brands, settings, Zoho mapping, webhook secret rotation, site keys, connections, sales, stats, resend, send now, CSV import with a dry run); operator console at `/admin`; `POST /internal/dispatch` for a scheduler.
- Not yet: per-user admin logins and brand self-service, rate limiting, KMS-backed secrets, Google OAuth connect flow in the UI (refresh token is pasted for now), a "send test event" button, pending-delivery index and TTL policies in Firestore, deployment (Cloud Run, Cloud Scheduler).
- Original plan items for this part:

#### Senders (about 1–1.5 weeks)
- Meta CAPI tag: `physical_store` events, `ph`/`em`/`fbc`/`fbp`, `event_id`, test event code support.
- Google Ads: offline click conversion with `gclid`, or enhanced conversions with hashed identifiers; `order_id`; batch uploads on a schedule within Explorer limits.
- Retry via Cloud Tasks or Pub/Sub with backoff; failures recorded.
- **Exit:** end to end on the dev project: click, identify, sale, event visible in Meta Test Events and Google diagnostics.

### Part 5: Reporting (about 3–4 days)
- Cloud Logging sink to BigQuery.
- Looker Studio report: events sent, skipped (with reason), failed, match source (click ID vs hashed contact only vs unmatched), by store and campaign.
- Alerts: failure rate, token expiry, drop in volume.
- **Exit:** a dashboard Lucira's team can read.

### Part 6: Lucira pilot (about 2 weeks, calendar time)
- Deploy to prod project; CNAME and `tracker.js` on the Lucira site.
- Shadow mode (log only), compare counts against Zoho and the platforms.
- Disable overlapping integrations; confirm consent wording in place.
- Enable sending; monitor match quality and delivery for two weeks.
- **Exit:** agreed success measures (delivery rate, share matched, no duplicates) met.

### Part 7: Multi-brand readiness (Phase 2, about 3–4 weeks)
- Terraform and GTM API automation to onboard a brand in about a day.
- Per-brand Firestore databases; shared BigQuery logging.
- **Sender API** on Cloud Run: per-brand credentials, queue, retries, idempotency, delivery log.
- Upgrade Google access to Basic when needed.

### Part 8: Platform (Phase 3, about 3–5 months)
- Postgres control plane, admin app, OAuth connectors, more sources (HubSpot, Shopify, WhatsApp) and destinations (TikTok, GA4), billing, own collector replacing sGTM, security review.
- Start only when several brands are paying and connector demand is clear.

## 7. Timeline (one developer using Claude, reviewing and testing)

| Stage | Estimate |
|---|---|
| Parts 0–5 | about 3–4 weeks |
| Part 6 (pilot) | about 2 weeks, mostly waiting and comparing |
| **Phase 1 total** | **about 5–6 weeks** |
| Part 7 | 3–4 weeks |
| Part 8 | 3–5 months |

Not sped up by tooling: GTM UI configuration and debugging, waiting on brand DNS and account access, real-data testing, code review, pilot duration.

## 8. Cost (rough, from memory of list prices; **VERIFY**)

Phase 1, for a brand with 50k sessions/day and filtered capture (server traffic about 50k requests/month):

| Item | Per month |
|---|---|
| Cloud Run sGTM, one or two always-on small instances | $50–100 |
| Firestore, BigQuery, logging, secrets, DNS | $2–10 |
| Optional sGTM preview server | $0–25 |
| **Total** | **about $55–110** |

Scale-to-zero would cut it to roughly $5–15 but risks cold-start delays and lost events. Sending to Meta and Google is free. Main non-infrastructure costs are engineering time, support and compliance.

Pricing idea for a product: charge by events sent and destinations connected, not by website traffic.

## 9. Known limits (be honest with brands)

- Anonymous visitors who change device or browser before identifying cannot be linked. Cleared cookies, private mode, blocked scripts and in-app browsers lose click IDs.
- Safari caps JavaScript-written cookies and localStorage at about 7 days; server-set cookies may last longer if Safari treats the server as first-party (**VERIFY**).
- Without a click ID, Google matching is weaker than Meta matching.
- Reported numbers depend on how many customers give a phone or email, and how early.

Dashboard metrics that expose this: share of sales with a click ID, matched by hashed contact only, unmatched, and skipped (consent, age).

## 10. Risks and open items

| Item | Action |
|---|---|
| Explorer limit (2,880 production operations/day): per project or per account; per row or per batch | Check before adding a second brand |
| Offline click uploads allowed on Explorer | Test in Part 0 |
| Meta age limits per `action_source`; WhatsApp CAPI-for-messaging requirements | Check Meta docs before Part 4 |
| Safari cookie lifetime with CNAME-based first-party server | Test on real Safari before promising |
| Double counting with Shopify apps and Zoho integrations | Channel filter, shared IDs, switch off overlaps before go-live |
| DPDP consent and processor responsibilities | Written split with each brand, legal review of wording |
| sGTM has no built-in retries, tenant management or admin UI | Cloud Tasks for now; Sender API in Part 7 |
| GTM config drift across brands | Export and version GTM containers; template them |

## 11. First steps once we start

1. Part 0 checks (accounts, test conversion in each platform).
2. Scaffold the repo and local Docker setup.
3. Build and test the shared library (hashing, normalisation, matching).
4. Then `tracker.js` and the Firestore model.

---

## Audit follow-up (9 October 2026)

An independent audit (`docs/server-side-conversion-audit.md`, benchmark in `docs/conversion-benchmark-results.json`) reviewed the code. I checked its main findings against the code and they held up.

**Step 1: fixed (226 tests passing, each fix has a regression test)**
- Delivery queue no longer starves: due work is selected by the database, not filtered from the first 500 rows (needs the deployed indexes).
- Leases have an owner token: a slow worker cannot overwrite the result of the one that took over. Claims and real send attempts are counted separately, so waiting for a connection no longer uses up retries, and a delivery that keeps crashing workers is given up on.
- Consent withdrawal is durable: `POST /consent` from the website, an operator form in the console, and an explicit "no" at identify time all record a suppression keyed by hashed contact details (works for CRM-only customers). Sales are checked when received and again right before each send; the browser clears cookie, storage and memory, in opt-in and opt-out mode.
- A suspended brand sends nothing: the console's "Send now" and import are refused, and a run already under way stops before the next delivery.
- A success reply that cannot be read is retried (same IDs), not reported as sent; Meta trace IDs and Google request IDs are kept; a Google OAuth rate limit (429) or outage is temporary, only a refused grant flags the connection.
- Ingest logs use an allowlist (only mapped business fields; phone and email shown as redacted) instead of redacting two paths.
- The website script keeps its storage per site key, no longer keeps phone or email text in sessionStorage, and does not renew a click when the landing page is reloaded.
- The copied script tag now carries `data-consent-mode="opt_out"` for opt-out brands.

**Not done yet, in the audit's order**
1. ~~Google transport: move to the Data Manager API.~~ **Done in code** (see below); still needs a run on a real Google Ads test account.
2. Per-event Google conversion actions (lead vs purchase vs stage); the current connection has a single action.
3. Event-owned click IDs and browser context (gclid, fbc, fbp, source URL) in the sale schema; Meta website events with real web context instead of `system_generated`.
4. Canonical event IDs across sources (CSV and CRM copies of one sale), occurrence/stage IDs, refunds and corrections.
5. Website conversion tracking (`track()` events), Shopify and ecommerce adapters.
6. Erasure of sale hashes and merged records; logical expiry; delivery snapshots of the credited click.
7. Per-user admin logins, tenant roles, audit log, rate limiting, signed webhooks; bounded concurrency in the dispatcher; setup verification and complete metrics.

**Step 2: Google Data Manager API (built, tested with a fake Google, not yet run against a real account)**
- The retired `uploadClickConversions` sender is replaced by `events:ingest` (`packages/senders/src/google.ts`), built from Google's current documentation. Setup guide and a VERIFY checklist: `docs/google-data-manager-setup.md`.
- Per sale: real event time, `transactionId` for deduplication, `eventSource` from the channel (IN_STORE, MESSAGE, WEB), one click ID, hashed email/phone, and an explicit `adUserData` consent only when the sale carries a yes.
- Email normalisation now follows Google's rule (Gmail: dots and `+suffix` removed); this fixes a silent loss of matches for Gmail addresses with plus tags.
- Accepted is tracked separately from processed: the request ID is kept and `requestStatus:retrieve` is polled (30 min, ×1.3, max 60 min, 24 h). The console shows processed / partly rejected / rejected with reasons.
- "Check connection" validates the account and conversion action with `validateOnly` (sends nothing). `scripts/google-refresh-token.ts` gets a brand's refresh token with the right scope.
- Not done: batching (one event per request today; the API takes 2,000), per-event conversion actions, Store Sales as a separate destination, a "Connect Google" button in the console.

**Step 2b: service-account login for Google (built, tested with a generated RSA key and a fake Google, not yet run against a real account)**
- A brand can be connected through the product's own service account (recommended) or through its own OAuth refresh token, chosen per brand. The service account route stores no secret per brand, needs no per-brand sign-in, and (per Google's docs) is not subject to OAuth app verification. The OAuth route needs that verification before production because the `datamanager` scope is sensitive.
- Platform key: `GOOGLE_SERVICE_ACCOUNT_JSON` / `_FILE`. One token (RS256 JWT bearer grant, cached) serves every brand.
- Errors say whose problem it is: a brand that has not added access yet is flagged with the exact email to add; a rejected or missing platform key fails the delivery without flagging the brand; outages retry.
- Unverified: what Google's "Account access setup" step for service accounts on Google Ads requires, and which access level (Standard vs Admin) the user role needs.

**Step 3: first-party tracking address (built, tested, and checked in Chrome on two `*.localhost` hostnames; not yet on real DNS, certificates or Safari)**
- Each site key can have the brand's own tracking address; the console shows the DNS record to add and a script tag that uses it. `/touch` sets a signed, HttpOnly first-party cookie on that address, nothing is stored server-side, and identify reads it back and merges it with the browser's copy. Withdrawal clears it. Details, limits and the local test recipe: `docs/first-party-tracking.md`.
- Honest limit: Safari may still cap a CNAME-reached cookie at about 7 days; the robust fix is the brand proxying a path of its own domain to us. Certificates for brand addresses are a deployment task (not built).
- The console can now **preview exactly what would be sent** to Meta and Google for any delivery (built by the real sender code, no secrets, nothing sent), which is how first-party data is checked end to end.
- Also built: `scripts/demo-site.ts`, a pretend brand site on its own hostname for that test.

**Step 3b: "Check setup" for the tracking address (built, tested, and run in Chrome for a working local address and a not-yet-existing one)**
- The console shows the exact DNS record (a CNAME, no TXT needed for it) and refuses to call it ready while `PUBLIC_URL` is `localhost`. A **Check setup** button tests DNS, HTTPS/routing, the script file, cross-site permission, the first-party cookie and whether the tag is on the brand's pages, with a plain-language fix for each failure. Details: `docs/first-party-tracking.md`.
- Still open for deployment: automatic HTTPS certificates for brand addresses (this decides whether any extra TXT/CNAME record is also needed), and `PUBLIC_URL`.

**Console visual refresh (done)**
- The console borrows ideas from Magic UI's design language, recreated in plain CSS and a few lines of script (no React, Tailwind, web fonts or external requests): a soft pastel glow and dot backdrop, near-black primary buttons with a shimmer, pill tabs, a colour beam around the one card that needs attention, a bento overview with count-up numbers, a cursor spotlight on cards, pill status badges with pulsing "waiting" dots, blur-fade entrance, a light/dark toggle (remembered in the browser) and full reduced-motion support. No behaviour changed. Checked in Chrome in dark and light and at phone width; not checked in Safari or Firefox. The sales table scrolls sideways on a phone rather than turning into cards.

**Console interaction polish (done)**
- Tab changes no longer flash. The old build threw the whole page away on every navigation (top bar, brand header, data) and replayed an entrance animation on everything. Now the top bar and brand header persist, the brand is fetched once, and only the content under the tabs swaps: the old content stays until the new content is ready, a skeleton appears only if a load takes over about 160 ms, slow answers for a tab you already left are discarded, and saving redraws in place keeping your scroll position and focus. Measured in Chrome over 8 tab switches: the top bar, header and tab bar were never replaced, the content area was never blank, and each switch swapped the content exactly once. Regression tests cover this (`packages/admin-ui/test`).
- Also: in-page confirmation dialogs instead of browser pop-ups; dialogs that fade out and close with Escape; spinners on buttons while they work; "Copied" feedback on the button; relative times with the exact time on hover; a search box on the brand list; icons; page titles; focus moved to the new page's title; no theme flash on load; the count-up always ends on the true value; pages start at the top; tall dialogs keep their buttons in view; phone-friendly brand list.
- Not done: the console is not tested in Safari or Firefox; the sales table still scrolls sideways on a phone.

**Console simplification for new users (done)**
- The Overview of a new brand is a numbered "Get set up" guide (website, CRM, ad accounts, first sale) with a progress bar and one strong button on the next step; the numbers appear once there is something to count.
- Forms moved out of the pages into dialogs opened by a button (add website, install script, tracking address and its DNS record, Zoho field mapping, connect Meta, connect Google Ads, import sales, privacy request). Rarely needed options sit under "More" or "Advanced". Each page lists things as one row with a state and one or two actions.
- Tabs are in setup order: Overview, Website, CRM, Ad accounts, Sales, Settings (Import is a button under Sales; old `#/…/import` links land on Sales). The Sales table shows only status chips; "Details" opens the full reasons, Preview and Send again.
- Not done: no walk-through for a brand that has no CRM other than Zoho; copy has not been tested with a real first-time user.

**Pre-deployment code fixes (done)**
- Send switch: `OUTBOUND_SENDS` (default off) enforced inside the dispatcher, so the scheduler and "Send waiting sales now" are both held back; optional `SEND_ALLOWED_TENANTS` and `SEND_ALLOWED_DESTINATIONS`. Blocked deliveries stay queued, unclaimed, no attempt counted. The console shows the state and disables the button. `npm run dev` sets it on; a real deployment must set it on deliberately.
- Claim limit: a worker that finishes a delivery resets its claim count, so waiting for a connection no longer ends in `too_many_claims`; only deliveries that keep crashing workers reach the limit.
- Setup checker: connects only to the address it validated (no DNS rebinding), blocks IPv6-wrapped and reserved addresses and IP literals, only allows `*.localhost` on a development server. CORS must be right on the real answer as well as the preliminary one; the tag must be an actual `<script>` with this key whose `data-endpoint` is the tracking address.
- First-party cookie: always under the browser's size limit (drops campaign details, then in-between clicks; refuses a single click that cannot fit). Tenant retention now applies to clicks read from the cookie and from the browser, and to what is written back; older clicks are ignored rather than failing a sign-up.
- Still open before a real deployment: production start/build and Dockerfile, Firestore indexes and TTL policies, HTTPS certificates for brand tracking names, login rate limiting for `/admin`, and the account-side items (staging project, secrets, Meta/Google setup).

**Deployment readiness (done)**
- `npm run build:release` builds `dist/release` (the collector bundled into `server.mjs`, the script, the console); `npm start` runs it. `Dockerfile` builds an 83 MB non-root image from the lock file; it stops cleanly on SIGTERM.
- With `NODE_ENV=production` the server refuses to start unless: real Firestore (no emulator) and a named project, a real 32-byte `SECRETS_KEY`, long random `ADMIN_TOKEN` and `INTERNAL_TOKEN`, an https `PUBLIC_URL`, the built files present, and no local-only timer. It lists every problem at once.
- `deploy/`: Firestore composite indexes for the sending queue, automatic-deletion policies on every expiring collection (not on withdrawals), deny-all rules, and `setup-firestore.sh`. A test keeps the indexes in step with the queries.
- `/admin/api` and `/internal/dispatch` lock an address out after 10 wrong tokens for 15 minutes (counted per instance; client address read correctly behind Google's proxy).
- `docs/deploy-staging.md`: the commands, in order. Not yet run against a real project.

**Review follow-ups (done)**
- Customer erasure: `Store.erase` + `SalesRepo.anonymizeCustomer` (via `eraseCustomer` in ingest): deletes the website profile, clicks, identities and merge leftovers, strips contact hashes and keys from sales (the sale stays), cancels unsent deliveries, records a suppression. Console: Settings, "Erase a customer". Data already at Meta/Google is out of reach and the dialog says so.
- Retention cache: stores are cached per brand and retention, so a retention change applies within about a minute instead of never (and a store made without a retention no longer wins).
- Stop procedure: a Firestore-backed "Pause all sending" (console, Brands page). SUPERSEDED by the next section: the first version's "at most one send per instance, within 3 seconds" claim was unsupported.
- Bootstrap: `PUBLIC_URL` is now worked out from the project number and set on the first deploy.
- Public throttling: per-address budgets on the website endpoints and webhooks, and a pause for addresses sending wrong webhook secrets.
- Still untested for real: Firestore indexes and TTL on a real project, Cloud Run permissions and proxy headers, Zoho webhooks, Meta receipt, Google processing results. Sales and deliveries are kept 400 days whatever the brand's retention setting (a decision to revisit).

**Console polish, round 3 (done)**
- Overview: a "Needs attention" card on top (broken connection with the platform's error, sales that failed or were rejected after acceptance, sending being held back), each with a button that goes to the fix or to exactly those sales; the platform counts are clickable; the setup step says "Fix your ad account connection" when one is broken.
- Sales: filter by what happened (needs attention / waiting / sent / skipped, with counts), by platform, and search by sale ID or store; "not linked" instead of "none"; the filter chosen on the Overview is used once.
- Brands list: status filter with counts and "show 50 more" instead of drawing every row.
- Settings: Save is disabled until something changes, and says when there are unsaved changes.
- Phone: the chosen tab stays in view, brands and sales tables fit (the sales "Details" link still scrolls slightly). The brand title no longer keeps a focus ring after navigating.

**Review follow-ups, round 2 (done)**
- Erasure and privacy requests now cover every linked contact detail: keys come from the contact given, the website profile, and every sale carrying any of them (followed to a fixpoint, refused with nothing changed past 50, which means a shared number). All are suppressed BEFORE anything is cleared, so an email-only purchase after erasing by phone is skipped (reproduced: it used to be pending for both platforms; the test fails on the old behaviour). The operator's "privacy request" uses the same reach; the unauthenticated website opt-out deliberately does not.
- Pause: a live (uncached) check of the pause and of the brand's status as the very last step before each request, with the delivery returned to the queue untouched if it fails, and one dispatch at a time per instance. The guide now states the real bound: one send per running instance whose last check preceded the pause; the 3-second cache is only for the on-screen label. Not measured on Cloud Run.

## Match quality (round: details that raise the match rate)
- Sales can now carry first/last name, city, state, postal code, country and the brand's own customer ID (Zoho mapping
  fields, standard JSON, CSV columns). Hashed with each platform's rules; Google's country and postal code are kept as
  given (it takes them unhashed). The country is only what the address says (not guessed from the phone number); Google's address needs it. Meta's hashed
  fields are sent as lists; state names (India, US) become codes (Maharashtra -> mh) before hashing.
- The tracker sends Meta's browser ID (`_fbp`, set by the brand's Meta pixel) with identify; it is kept on the person and
  copied to their sales. It is not created by us yet (that comes with web events).
- Meta gets fn/ln/ct/st/zp/country/external_id/fbp; Google gets an address identifier only when name, country and postal
  code are all present. "Preview what is sent" lists what each sale is matched on and what is missing.
- Deliberately NOT done: client IP and user agent. For store and CRM sales they would be the website visit's, not the
  purchase's, and storing IPs is a privacy decision. They belong with web events, where the live request supplies them.
- Zoho defaults do not include the new fields: a wrong field name makes the daily sync's query fail, so each brand
  opts in from the mapping dialog.
- All field formats are marked VERIFY and must be checked against Meta's and Google's current docs and a real test event.

## Import must be checked first
- The Import dialog has one button: "Check file", then "Import N sales" once the file has passed. Editing the file or
  choosing another one takes the import away until it is checked again. The check shows a summary (new vs already
  imported, value, dates, rows without phone or email, consent, name/postal coverage).
- The server enforces it too: a real import needs the `checkToken` from a clean check of exactly that file for that brand
  (HMAC over brand + file hash + time, valid 30 minutes). A file with any problem row gets no token, so nothing in it can
  be imported until it is fixed.
- The check is strict: consent must be yes/no (or empty), anything else rejects the row (also in the standard JSON,
  where it must be true/false); days that do not exist (2026-02-30) are rejected everywhere dates are read; broken
  quoting and rows with more values than the header are rejected; the confirmation describes only the rows that will
  be added, never the skipped duplicates.

## Install snippets (Google Tag Manager and direct)
- The console now gives two labelled options per website: a Google Tag Manager loader (creates the script element and
  sets `data-key`, `data-endpoint`, and `data-consent-mode` for opt-out brands before adding it) and the plain script
  tag. Both come from one builder (`packages/server/src/snippets.ts`) using the brand's real key, tracking address and
  consent mode, with values escaped for HTML attributes and for JavaScript strings inside an HTML script element.
  The opt-in default is not written out, so consent behaviour is unchanged. Instructions: docs/install-script.md.
- The reason the plain tag lost its attributes in one brand's Tag Manager is not established; documented as observed.
- Not changed: the tracker's public API, form detection (automatic login/sign-up capture is a separate task).
