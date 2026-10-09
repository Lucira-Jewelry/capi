# Conversions platform

Multi-tenant service that captures ad click IDs on a brand's website, receives sales from the brand's CRM, and sends them to Meta (Conversions API) and Google Ads (offline conversions). See `PLAN.md` (plan and status) and `SPEC.md` (detailed rules).

## Packages

| Package | What it does |
|---|---|
| `core` | Hashing and phone/email normalisation, consent rules, touch selection, eligibility and age limits, tenant types |
| `store` | Firestore data: people and touches, sales and deliveries, tenants and site keys, encrypted connections |
| `tracker` | The website script (`tracker.js`, about 5.5 KB) |
| `ingest` | Sources to one standard sale (Zoho, generic JSON, CSV), the pipeline, the Zoho sync |
| `senders` | Meta and Google senders, retry policy, the dispatcher |
| `server` | HTTP: `/identify`, `/consent` (withdrawals), `/touch` (first-party cookie), `/webhooks/{brand}/{zoho\|generic}`, `/admin/api`, `/internal/dispatch` |
| `admin-ui` | The operator console, served at `/admin` |

## Run it locally

```sh
npm install
docker compose up -d firestore      # Firestore emulator on :8080
npm run build                       # tracker.js and the admin UI
npm run dev                         # http://localhost:8787/admin   (token: dev-admin-token)
```

`npm run dev` uses a fixed development-only `SECRETS_KEY` and `ADMIN_TOKEN` and sends due sales every 30 seconds
(`DISPATCH_INTERVAL_SECONDS=0` turns that off, which is wise when testing with placeholder tokens).

```sh
npm test                 # unit tests (no emulator needed)
npm run test:emulator    # everything, including Firestore-backed tests
npm run typecheck
```

## Configuration (production)

All brand settings live in Firestore and are managed in the admin. The server needs only:

| Variable | Purpose |
|---|---|
| `SECRETS_KEY` | 32-byte base64 key that encrypts ad-account tokens. Losing it means every brand must reconnect. |
| `ADMIN_TOKEN` | Operator login for `/admin` (a single shared token for now; per-user logins are not built yet) |
| `PUBLIC_URL` | Public base URL, shown in the script tags and webhook URLs |
| `INTERNAL_TOKEN` | Lets a scheduler call `POST /internal/dispatch` (header `x-internal-token`), for example every minute |
| `COOKIE_SECRET` | Optional. Signs the first-party cookie; defaults to a value derived from `SECRETS_KEY`. See `docs/first-party-tracking.md` |
| `GOOGLE_SERVICE_ACCOUNT_JSON` or `GOOGLE_SERVICE_ACCOUNT_FILE` | The product's Google service account key (recommended): brands add its email to their Google Ads account, no per-brand tokens. From the Google Cloud project that has the Data Manager API enabled. See `docs/google-data-manager-setup.md` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Optional: the product's Google OAuth client, for brands connected with a refresh token instead |
| `GOOGLE_CLOUD_PROJECT` | Firestore project |

## Before real traffic

- Everything marked **VERIFY** in the code and docs: Meta and Google API versions, event rules, age windows, error codes, the Zoho COQL query.
- Test one real event with a Meta test event code, and one Google sale end to end on a test account (see the checklist in `docs/google-data-manager-setup.md`).
- Replace the single admin token with real user logins, and add rate limiting on `/admin/api` and `/identify`.
- Deploy the Firestore indexes in `infra/firestore/firestore.indexes.json` (the delivery queue queries need them) and enable the TTL policies (`infra/firestore/README.md`).
- Use Cloud KMS / Secret Manager envelope encryption in place of the environment master key.
