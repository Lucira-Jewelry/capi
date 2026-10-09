# Conversion Tracking Platform: Technical Spec (draft v0.1)

Multi-tenant platform that captures ad click IDs on a brand's website, links them to people, and sends sales (online, store, WhatsApp) back to Meta and Google Ads.

Items marked **VERIFY** depend on current Meta/Google API rules and must be checked against their docs before building.

---

## 1. Do we build our own tracking script?

**Yes.** Click IDs only exist in the browser at click time, so we ship a small first-party script (`tracker.js`) that the brand installs. Without it we are limited to hashed phone/email matching.

| Layer | Who provides it |
|---|---|
| `tracker.js` (capture + identify) | **Us** (hosted, versioned, ~3 KB) |
| Collector endpoint (`/collect`) | **Us** |
| First-party cookie server + TLS cert | **Us** (provisioned automatically for the brand's CNAME) |
| Installing the script tag (or GTM tag) | **Brand** |
| One DNS CNAME (`track.brand.com`) | **Brand** |
| Forms that collect phone/email | **Brand** (script auto-binds to them) |
| Consent banner + privacy policy wording | **Brand** |
| Meta + Google Ads + CRM account access (OAuth) | **Brand** (they click "connect") |

The CNAME is optional for the MVP (the script works cross-origin to our domain) but strongly recommended: it lets the server set cookies on the brand's own domain, which survive Safari ITP.

---

## 2. Tech stack

- **Runtime:** Node.js (TypeScript) on Cloud Run. Separate services: `collector` (high-volume, thin), `api` (admin/OAuth/webhooks), `worker` (senders).
- **Queue:** Pub/Sub or Cloud Tasks, with per-tenant and per-destination rate limiting.
- **Database (Phase 3 control plane):** PostgreSQL (Cloud SQL). Joins and per-tenant reporting are core. Row-level security on `tenant_id`.
- **Phase 1 (sGTM + Firestore, Lucira and a few brands):** no Postgres. Firestore holds identities and touches (keyed by hashed phone/email, with TTL up to 90 days), BigQuery holds logs and reports, and Cloud Tasks/Pub/Sub handle retries. The sGTM container runs on Cloud Run behind the brand's CNAME; our Sender API (control plane) is added in Phase 2. Build and test locally first (sGTM Docker image, Firebase Emulator Suite), then move to a small GCP dev project.
- **Cache / dedup:** Redis (short-lived idempotency keys, rate limits).
- **Secrets:** Secret Manager / KMS for OAuth tokens (never in plain DB columns).
- **Admin app:** Next.js + auth (org, users, roles).
- **Script build:** esbuild, served from CDN with a cache-busting version.
- **Infra as code:** Terraform. **Observability:** structured logs, Sentry, alerting on delivery failure rate and token expiry.
- **Reporting later:** BigQuery export if Postgres becomes slow.

---

## 3. Data schema (PostgreSQL)

All tables carry `tenant_id`. Hashes are lowercase hex SHA-256.

```sql
-- Tenancy and connections
create table tenants (
  id uuid primary key,
  name text not null,
  country text,                       -- default phone region
  retention_days int not null default 90,
  consent_policy jsonb not null,      -- e.g. {"mode":"opt_in","regime":"DPDP"}
  created_at timestamptz default now()
);

create table connections (            -- OAuth links to external systems
  id uuid primary key,
  tenant_id uuid references tenants,
  kind text not null,                 -- meta | google_ads | zoho | whatsapp | shopify
  external_account_id text,           -- pixel/dataset id, customer id, org id
  secret_ref text not null,           -- pointer into Secret Manager
  config jsonb,                       -- conversion action, field mapping, filters
  status text default 'active',       -- active | expired | error
  created_at timestamptz default now()
);

create table sites (                  -- a brand's website(s) running tracker.js
  id uuid primary key,
  tenant_id uuid references tenants,
  domain text not null,
  public_key text unique not null,    -- used by tracker.js
  collector_host text                 -- track.brand.com
);

-- People and identity
create table persons (
  id uuid primary key,
  tenant_id uuid references tenants,
  phone_hash text,
  email_hash text,
  external_id text,                   -- CRM contact id if known
  consent jsonb,                      -- {ads:true, ts, source, text_version}
  first_seen timestamptz,
  last_seen timestamptz
);
create unique index on persons (tenant_id, phone_hash) where phone_hash is not null;
create unique index on persons (tenant_id, email_hash) where email_hash is not null;

create table visitors (               -- anonymous browser identity
  id uuid primary key,                -- stored in first-party cookie
  tenant_id uuid references tenants,
  person_id uuid references persons,  -- null until identified
  fbp text,
  user_agent text, ip_hash text,
  first_seen timestamptz, last_seen timestamptz
);

-- Touches (the click IDs)
create table touches (
  id uuid primary key,
  tenant_id uuid references tenants,
  visitor_id uuid references visitors,
  person_id uuid references persons,  -- backfilled on identify
  gclid text, gbraid text, wbraid text,
  fbclid text, fbc text,              -- fbc = fb.1.<click_ms>.<fbclid>
  ctwa_clid text,
  utm jsonb, landing_url text, referrer text,
  clicked_at timestamptz not null,    -- ORIGINAL click time, never rewritten
  expires_at timestamptz not null     -- clicked_at + retention
);
create index on touches (tenant_id, person_id, clicked_at desc);

-- Business events (sales, leads, etc.)
create table events (
  id uuid primary key,
  tenant_id uuid references tenants,
  person_id uuid references persons,
  event_name text not null,           -- lead | purchase | appointment | ...
  event_id text not null,             -- stable ID; dedup key (deal id, order id)
  channel text not null,              -- online | store | whatsapp | web_lead
  value numeric, currency text,
  occurred_at timestamptz not null,
  source text not null,               -- zoho | shopify | webhook | csv | tracker
  source_ref text,
  raw jsonb,
  created_at timestamptz default now(),
  unique (tenant_id, source, event_id)
);

-- Deliveries (one row per event per destination)
create table deliveries (
  id uuid primary key,
  tenant_id uuid references tenants,
  event_id uuid references events,
  destination text not null,          -- meta | google_ads
  status text not null,               -- pending | sent | failed | skipped
  skip_reason text,                   -- no_consent | too_old | no_identifiers | channel_filtered
  attempts int default 0,
  request jsonb, response jsonb,
  touch_id uuid references touches,   -- which click was attributed
  next_retry_at timestamptz,
  sent_at timestamptz,
  unique (event_id, destination)      -- idempotency
);

create table ingest_log (             -- every webhook / sync run, for debugging
  id uuid primary key, tenant_id uuid, kind text, payload jsonb,
  error text, created_at timestamptz default now()
);
```

---

## 4. Capture logic (`tracker.js`)

1. On every page load, read `gclid`, `gbraid`, `wbraid`, `fbclid`, `utm_*` from the URL.
2. If present, **store the touch in the visitor's browser only** (first-party cookie plus localStorage): click IDs, UTMs, landing URL and the original click time. Keep the first and the most recent touch. **Nothing is sent to our server and nothing is saved in our database before the visitor identifies themselves.**
3. Build `fbc` as `fb.1.<click_ms>.<fbclid>` if `fbclid` exists and `_fbc` is not already set. Read `_fbp` if set.
4. Cookie lifetime depends on the browser: Safari caps JavaScript-written cookies and localStorage at about 7 days. A server-set cookie (HTTP `Set-Cookie`, `Secure; SameSite=Lax`) via the brand's CNAME may last longer, but only if Safari treats the server as first-party. **VERIFY** before promising anything beyond 7 days on Safari. In-app browsers (Instagram, Facebook), cross-device journeys and cleared cookies lose the stored IDs; this cannot be fixed by design (see section 12).
5. **Consent gate:** if the brand's CMP says "no ad consent", the script sends nothing (or only anonymous, non-ad data).
6. **Identify:** auto-bind to forms (`input[type=tel|email]`) and expose `tracker.identify({phone, email})`. On submit, send the plain phone/email over HTTPS to our own first-party `/identify` endpoint together with the stored touches. **The browser does not hash:** Meta and Google hash phone numbers differently (Meta without the `+`, Google with it), so a single browser-side hash cannot serve both. The server normalises, derives each platform's hash, stores only hashes, and discards the plain values.
7. Optional: write `gclid`/`fbc` into hidden fields so the CRM lead carries them too (useful as a fallback).

**Server on `/identify` (the first moment anything is stored):** validate `public_key`, check consent, upsert `persons` from the hashed phone/email, and insert the touches the browser sent, with their original click times. Anonymous page views and click IDs of people who never identify are never written to our database.

---

## 5. Identity resolution rules

- Normalise before hashing: phone to E.164 (default region from tenant), email trimmed and lowercased. Hash with SHA-256.
- Match on `phone_hash` first, then `email_hash`. If one person matches by phone and another by email, merge and keep both hashes.
- One visitor can map to one person; one person can have many visitors/devices.
- Unidentified visitors are never sent anywhere.

---

## 6. Event ingestion

| Source | How |
|---|---|
| Zoho CRM | Workflow webhook on deal Won + daily API sync (zoho.in or .com data centre per tenant) |
| Shopify | Webhook `orders/paid`. **Only used if the brand has no existing Meta/Google app reporting** (dedup rule 8.1) |
| WhatsApp Business API | Webhook; read `referral.ctwa_clid` on first message, store as a touch against the sender's phone |
| Generic webhook / CSV | Mapped to the canonical event |

Every source maps into the `events` table. `unique (tenant_id, source, event_id)` makes re-delivery safe.

---

## 7. Matching and sending rules

For each new event, the worker creates one `deliveries` row per enabled destination, then evaluates in order:

1. **Consent:** if `persons.consent.ads` is not true, set `skipped / no_consent`.
2. **Channel filter:** apply tenant config (for example, skip `online` when Shopify apps already report it), set `skipped / channel_filtered`.
3. **Identifiers:** need at least one of phone_hash, email_hash, or a click ID, otherwise `skipped / no_identifiers`.
4. **Pick the touch:** from the person's unexpired `touches`, choose the **most recent touch before `occurred_at`** that has an ID relevant to the destination (Meta: `fbc` or `ctwa_clid`; Google: `gclid`/`gbraid`/`wbraid`). Record it in `deliveries.touch_id`.
5. **Age check per destination** (limits are configuration, not hard-coded, **VERIFY**):
   - Google: conversion within about 90 days of the click.
   - Meta: website events must be recent (about 7 days); offline / non-website events allow a longer window.
   - Otherwise `skipped / too_old`.
6. **Send** (below), then mark `sent` or schedule a retry with exponential backoff (max N attempts, then `failed` and surface in the admin UI).

### 7.1 Meta (Conversions API)

`POST /{dataset_id}/events`

- `event_name`: Purchase, Lead, Schedule, etc. (mapped per tenant)
- `event_time`: `occurred_at` (unix seconds)
- `event_id`: `events.event_id` (dedup with the pixel for web events)
- `action_source`: `website` | `physical_store` | `business_messaging` (WhatsApp, with `messaging_channel: whatsapp`) | `crm` (for lead-stage events), by channel. **VERIFY** the exact values.
- `user_data`: `ph`, `em` (hashed), `fbc`, `fbp`, `ctwa_clid` (when present), plus IP and user agent for web events only.
- `custom_data`: `value`, `currency`.
- Support a **Test Events code** per connection for onboarding.

### 7.2 Google Ads (Google Ads API, not "CAPI")

- With a click ID: `uploadClickConversions` with `gclid` (or `gbraid`/`wbraid`), `conversion_action`, `conversion_date_time` (account timezone format), `conversion_value`, `currency_code`, `order_id` (= `event_id`).
- Without a click ID: enhanced conversions for leads, sending hashed `email` and `phone` as `user_identifiers`, with `order_id`. Match rate is lower.
- Auth is OAuth via our Google Cloud project; Google Ads developer tokens are no longer required, and API access levels are managed in the Cloud Console. We start on **Explorer** access (2,880 production operations/day, 15,000 on test accounts), which is enough for one brand's pilot. Batch uploads and send on a schedule. Apply for **Basic** access when adding more brands or nearing the limit. Also needs the brand's customer ID and an MCC login ID if applicable. **VERIFY** that offline click conversion uploads are allowed at Explorer level, and whether the limit is per project or per account.
- Handle partial-failure responses per row.

---

## 8. Double counting

1. **Existing apps.** Per tenant, onboarding asks what already sends conversions (Shopify Meta app, Shopify Google app, Zoho integrations, GTM server container). Default: send only channels nothing else covers (store, WhatsApp, CRM stages).
2. **Same-event dedup.** Use stable `event_id` for Meta and `order_id` for Google, shared with any pixel/tag event for the same action.
3. **Idempotency.** `deliveries` is unique on `(event_id, destination)`, so a replayed webhook never double-sends.

---

## 9. Privacy and retention

- Hash phone and email in the browser and on the server. Plain values are not stored unless a tenant explicitly needs them for CRM sync.
- Store consent state, timestamp, source and wording version with each person.
- A nightly job deletes expired touches and honours deletion requests across all tables.
- Region config (India DPDP, GDPR, CCPA) drives the default consent mode.
- We act as processor: DPA, subprocessor list, and a signed split of responsibilities with each brand.

---

## 10. Brand onboarding checklist

1. Connect Meta (OAuth), choose pixel/dataset, run a test event.
2. Connect Google Ads (OAuth), choose customer ID and conversion actions.
3. Connect CRM (Zoho) and map fields: phone, email, amount, store, channel, deal ID, consent.
4. Install `tracker.js` (script tag or GTM) and add the CNAME for `track.brand.com`.
5. Answer the existing-integrations questions (section 8.1).
6. Confirm consent banner and bill/form notice wording with their legal advisor.
7. Go live in shadow mode (log only), compare counts, then enable sending.

---

## 11. Open questions

- Meta: exact event age limits per `action_source`, and CAPI-for-messaging dataset requirements for WhatsApp. **VERIFY**
- Google: how Explorer-level operation limits are counted (per project or per account; per row or per batch), the requirements to upgrade to Basic, and whether to support Customer Match as a fallback.
- Postgres vs Firestore (Postgres recommended here).
- Build the Zoho connector first, or a generic webhook plus CSV first?

---

## 12. Known limits and what we can improve

**Inherent (no design fixes these).** Anonymous visitors who switch device or browser before identifying; cleared cookies, private mode and blocked scripts; click IDs stripped before they reach us; a click on one platform's ad followed by a purchase after coming through another platform's. Click IDs only exist in the browser at click time.

**Partly in our hands.**
- Safari cookie lifetime (server-set cookies on a properly configured first-party subdomain; verify behaviour).
- How early people identify: enquiry forms, WhatsApp chat (phone arrives automatically), gold-rate/price-alert sign-ups, login or checkout, phone number at the billing counter. Click-to-WhatsApp ads deliver `ctwa_clid` with the phone number.
- Hashed phone/email matching, so a lost click ID does not mean a lost match; the platforms match against their own logged-in users across devices.
- Sending within each platform's time limits and avoiding double counting (section 8).

**Dashboard metrics to expose these honestly:** share of sales with a click ID; share matched by hashed phone/email only; share unmatched; share skipped for consent or age.

**What we tell brands.** We recover what is recoverable: identified customers matched by hashed contact details, plus click IDs where they survived. We do not promise full attribution.

## 13. Brand technical checklist (website)

1. Install `tracker.js` on every page, including the landing pages ad clicks arrive on, loading early enough to read the URL before redirects or consent flows drop the parameters (respecting consent rules).
2. Cover the checkout domain too if it differs from the main domain (Shopify checkout is a common gap); cookies must be on the root domain to be shared.
3. Do not strip or rewrite `gclid`/`fbclid`/UTM parameters in redirects, link shorteners or ad URLs.
4. Add the CNAME for the tracking subdomain (`track.brand.com`).
5. Make sure every form that collects phone or email goes through `tracker.identify` (auto-bound or called explicitly).
6. Connect the consent banner to the script: no storage of click IDs without consent where the tenant's policy requires it.

## 14. Phase 1 cost (50k sessions/day, filtered capture)

With client-side storage and server calls only on identify, purchase and CRM events, server traffic is about 1.5-2k requests/day (roughly 50k/month), Firestore usage is about 5k writes and 5k reads/day (mostly inside the free allowance), and BigQuery volume is tiny. The cost is almost entirely the always-on Cloud Run instance(s) for sGTM: about **$55-110/month** with one or two small instances (about $50 each), plus $0-25 for an optional preview server. Letting Cloud Run scale to zero would cut this to roughly $5-15/month but risks cold-start delays and lost events, so keep one instance running in production. For comparison, sending every event to the server would cost about $120-250/month. These figures come from memory of list prices; check the pricing calculator.
