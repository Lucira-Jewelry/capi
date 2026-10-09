# Deploying a staging collector into an existing Google Cloud project

What is in the repository for this: `Dockerfile`, `deploy/` (Firestore indexes, retention policies, rules, setup script),
`.env.example` (every setting). The commands below have **not** been run against a real project yet: they are the
intended path, to be checked off as we go. The container itself has been built and run locally (see "What was checked").

This guide supports a staging service in an existing project. Keep its data isolated in a dedicated Firestore database named
`datahash-staging`; the application refuses to start in production if no named database is configured. Replace `PROJECT`
with the project ID (for example `lucirajewelry-prod`) and `REGION` (for example `asia-south1`).
Use a dedicated service account for this service. Its conditional Firestore grant below is limited to the staging database;
production credentials and the `(default)` database remain separate.

## 1. One-time project setup

```bash
gcloud config set project PROJECT
gcloud services enable run.googleapis.com firestore.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudscheduler.googleapis.com cloudbuild.googleapis.com

# Separate database (Native mode) for staging, with its own indexes and retention policies
gcloud firestore databases create --project=PROJECT --database=datahash-staging --location=REGION --type=firestore-native
FIRESTORE_DATABASE=datahash-staging deploy/setup-firestore.sh PROJECT
# optional, blocks direct access to the data from anywhere but the collector:
#   (cd deploy && firebase deploy --only firestore:rules --project PROJECT)

# The identity the collector runs as; Firestore access is limited to the staging database
gcloud iam service-accounts create collector --display-name "Collector"
SA=collector@PROJECT.iam.gserviceaccount.com
gcloud projects add-iam-policy-binding PROJECT --member serviceAccount:$SA --role roles/datastore.user \
  --condition='expression=resource.name=="projects/PROJECT/databases/datahash-staging",title=DatahashStagingFirestore,description=Access only to the staging Firestore database'

gcloud artifacts repositories create collector --repository-format=docker --location=REGION
```

## 2. Secrets (Secret Manager)

Create each once. **Keep `SECRETS_KEY` the same on every deployment**: a new key makes all saved ad-account tokens
unreadable (brands would have to reconnect).

```bash
rand() { node -e "console.log(require('crypto').randomBytes(32).toString('$1'))"; }
printf %s "$(rand base64)"    | gcloud secrets create SECRETS_KEY    --data-file=-
printf %s "$(rand base64url)" | gcloud secrets create ADMIN_TOKEN    --data-file=-
printf %s "$(rand base64url)" | gcloud secrets create INTERNAL_TOKEN --data-file=-
# Google service account key for the Data Manager API (later, once the Google step is reached):
#   gcloud secrets create GOOGLE_SERVICE_ACCOUNT_JSON --data-file=key.json
for s in SECRETS_KEY ADMIN_TOKEN INTERNAL_TOKEN; do
  gcloud secrets add-iam-policy-binding $s --member serviceAccount:$SA --role roles/secretmanager.secretAccessor
done
```

Read the admin token back when you need to sign in: `gcloud secrets versions access latest --secret ADMIN_TOKEN`.

## 3. Build and deploy

```bash
PROJECT_NUMBER=$(gcloud projects describe PROJECT --format 'value(projectNumber)')
URL=https://collector-$PROJECT_NUMBER.REGION.run.app
IMAGE=REGION-docker.pkg.dev/PROJECT/collector/collector:$(date +%Y%m%d-%H%M)
gcloud builds submit --tag $IMAGE .

gcloud run deploy collector --image $IMAGE --region REGION --service-account $SA \
  --allow-unauthenticated \
  --max-instances 2 \
  --set-env-vars GOOGLE_CLOUD_PROJECT=PROJECT,FIRESTORE_DATABASE=datahash-staging,OUTBOUND_SENDS=off,PUBLIC_URL=$URL \
  --set-secrets SECRETS_KEY=SECRETS_KEY:latest,ADMIN_TOKEN=ADMIN_TOKEN:latest,INTERNAL_TOKEN=INTERNAL_TOKEN:latest
```

`--allow-unauthenticated` is needed because browsers and the CRM call it; the console, the scheduler endpoint and
the webhooks are protected by their own tokens.

**`PUBLIC_URL` must be set on the very first deploy**, because the server refuses to start in production without it.
Cloud Run also gives every service a predictable address built from the project number, so it can be worked out
beforehand. The commands above calculate it and include it in `--set-env-vars`.

After the first deploy, **confirm that guess**: `gcloud run services describe collector --region REGION --format 'value(status.urls)'`
must list exactly `$URL`. If it does not, correct it with
`gcloud run services update collector --region REGION --update-env-vars PUBLIC_URL=<the real address>` (the service
can start with a syntactically valid but incorrect hostname, so verify the actual address before configuring a brand). With a
custom domain later, set `PUBLIC_URL` to that instead. If the service fails to start, the log lists every unsafe or
missing setting at once: `gcloud run services logs read collector --region REGION`.

## 4. Check it

```bash
curl $URL/health                                   # {"ok":true}
open $URL/admin                                    # sign in with ADMIN_TOKEN
```

In the console: create the staging brand, add its website, set the Zoho mapping. **Sending stays off**
(`OUTBOUND_SENDS=off`), so nothing leaves the server whatever buttons are pressed. Send a synthetic Zoho webhook, look at
the payload previews on the Sales tab.

## 5. Turning sending on, deliberately

Only after the previews are right and the destinations are connected:

```bash
gcloud run services update collector --region REGION \
  --update-env-vars OUTBOUND_SENDS=on,SEND_ALLOWED_TENANTS=<staging-brand-id>,SEND_ALLOWED_DESTINATIONS=meta
```

Meta first (with its test event code set). Add `google_ads` only after "Check connection" passes. Press "Send waiting
sales now" by hand for a few sales and inspect the results.

## 6. Scheduler (last, and paused at first)

```bash
gcloud scheduler jobs create http dispatch --location REGION --schedule "* * * * *" \
  --uri $URL/internal/dispatch --http-method POST \
  --headers "x-internal-token=$(gcloud secrets versions access latest --secret INTERNAL_TOKEN)"
gcloud scheduler jobs pause dispatch --location REGION     # resume only when manual sends look right
```

## Stopping sending

Four levers, from fastest to most final.

**What "stop" does and does not guarantee.** Before every request to Meta or Google, the instance reads the pause (and
the brand's status) **live from the database**, not from a cache, as its very last step. A send is only started if that
read says it is allowed; a delivery that fails the check goes back to the queue untouched. Each instance runs **one
dispatch at a time** (the scheduler and the console button take turns), so an instance has at most one send in flight.
So once the pause is saved:

- no instance starts a send whose last check happens after the pause was saved;
- a send whose last check happened *before* the pause was saved (a matter of milliseconds earlier) can still complete,
  and a request cannot be recalled once it has left; it gives up after 15 seconds;
- worst case that is **one send per running instance** (Cloud Run may run several, and an older revision can still be
  running briefly after a deploy), so with `--max-instances 2` at most two, plus anything a not-yet-replaced revision
  was doing. This is a bound from the design and from the tests on a single instance; it has not been measured on
  Cloud Run. The pause *label* shown on screen can lag up to 3 seconds (it is cached for display only).

1. **Pause all sending** in the console (Brands page). Takes effect as described above, no redeploy. Queued sales wait,
   untouched, and go out when you press Resume. Use this first.
2. **Suspend the brand** (Settings, Advanced, Status). Checked live in the same last step, for that brand. Also refuses
   its webhook and website script.
3. **Pause the scheduler**: `gcloud scheduler jobs pause dispatch --location REGION`. This only stops *new* runs
   starting; a run already going carries on until it hits lever 1 or 2. Pausing the scheduler alone is not a stop.
4. **Switch sending off in the settings**: `gcloud run services update collector --region REGION --update-env-vars OUTBOUND_SENDS=off`.
   This creates a new revision; instances of the old one keep running (and sending) until traffic has moved over,
   typically seconds but not instant. Use it as the lasting "off", after 1.

To stop *and* make sure nothing is running: pause sending (1), pause the scheduler (3), switch it off (4), and look at
`gcloud run services logs read collector --region REGION` for the last dispatch line.

Cleaning up the staging data: erase customers one by one from the console (Settings), delete the brand's documents, or
delete the whole test project.

## Things to know

- **Public endpoints** (`/identify`, `/touch`, `/consent`, `/trackcheck`) allow 300 requests per minute per address;
  webhooks 1200 per minute, and an address sending 30 wrong webhook secrets is paused for 5 minutes. Counted per
  instance, like the login limit. These are guards against abuse, not capacity planning: Cloud Run's own
  `--max-instances` is the real ceiling on cost.
- **Erasing a customer** (Settings in the console) first records that nothing may be sent for **every phone and email
  known to belong to them**: the ones typed in, the other details on their website profile, and the other details on
  any sale that carried one of them (followed until nothing new turns up). Only then does it delete their website
  profile and clicks, strip their contact hashes from past sales (the sale stays as an anonymous record) and cancel
  what is queued. So a later purchase under only their email, or only their phone, is held back. A phone or email
  shared by more than 50 other contact details (a shop's number, a family address) is refused and nothing is changed.
  "Customer privacy request" has the same reach but deletes nothing. The customer's own opt-out on the website
  (`/consent`) only covers the details they submit, because it is unauthenticated. Erasure cannot reach data already sent
  to Meta or Google; that has to be deleted in those platforms. Sales and deliveries are kept 400 days regardless of the
  brand's retention setting, which applies to website profiles and clicks.
- **Changing a brand's retention** takes effect within about a minute (the brand settings are cached that long).
- **Login guessing** is limited per address (10 wrong tokens locks that address for 15 minutes), counted per running
  instance. `--max-instances 2` keeps that meaningful. The server also refuses to start in production with an
  admin token shorter than 32 characters.
- **Behind a load balancer** (later, for brand tracking names) set `TRUSTED_PROXY_HOPS=2`, otherwise addresses are
  misread and the lock-out would hit the wrong people.
- **Retention**: documents delete themselves at their `expiresAt` time (people, identities, clicks 90 days by default;
  sales and deliveries 400 days; ingest log 30 days). Google deletes in the background, usually within a day of expiry.
  Withdrawal records never expire.
- **Single database region**: choose it once; it cannot be changed.

## What was checked, and what was not

Checked locally (emulator, one instance): a pause that lands after the early check but before the request still stops it and returns the delivery untouched; with one request in flight, none after it start; erasing a customer leaves no contact hash on their sales and a replayed webhook cannot bring them back (emulator); the production start refuses unsafe settings and lists them; the container builds (83 MB), runs as a
non-root user, serves `/health`, `/tracker.js` and `/admin`, and stops cleanly on SIGTERM; the bundle reads and writes
Firestore (emulator); the indexes file matches the queries in the code (a test fails if they drift).

Not checked, because there is no real project yet: that the gcloud commands above run as written; that the indexes
are accepted and the queue queries run on real Firestore (the emulator never needs indexes); the TTL policies;
Cloud Run behaviour such as cold starts and the `X-Forwarded-For` handling behind Google's front end.
