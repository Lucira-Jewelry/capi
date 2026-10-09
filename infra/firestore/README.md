# Firestore setup

Data lives under `tenants/{tenantId}/`:

| Path | Holds |
|---|---|
| `identities/{key}` | `personId` for a hashed phone or email key |
| `persons/{personId}` | hashes for Meta/Google, consent, first/last seen, `mergedInto` |
| `persons/{personId}/touches/{touchId}` | click IDs and the original `clickedAt` |

| `sales/{saleKey}` | one store/WhatsApp/etc. sale: value, channel, hashes, consent that applied (no plain contact details) |
| `sales/{saleKey}/deliveries/{destination}` | `pending`, `skipped` (with reason), later `sent` / `failed` |
| `suppressions/{identityKey}` | A customer who withdrew consent (hashed identity key). Checked when a sale is received and again right before every send. Lifted only by an explicit later "yes". Kept without expiry on purpose. |
| `ingest_log/{id}` | redacted webhook/sync trace, kept 30 days |

Only hashes and internal keys are stored, never a plain phone number or email. Enable TTL on `expiresAt` for `sales`, `deliveries` and `ingest_log` too.

## TTL (automatic expiry)

Every document has an `expiresAt` field. Enable TTL policies on it (they are not enforced by the emulator):

```sh
gcloud firestore fields ttls update expiresAt --collection-group=touches    --enable-ttl --database=(default)
gcloud firestore fields ttls update expiresAt --collection-group=persons    --enable-ttl --database=(default)
gcloud firestore fields ttls update expiresAt --collection-group=identities --enable-ttl --database=(default)
```

Retention defaults to 90 days (`retentionDays` on the `Store`). Persons and identities are refreshed on every identify call; touches expire 90 days after the original click. **VERIFY** the exact `gcloud` flags and TTL deletion behaviour in the current docs; TTL deletes happen within roughly a day of expiry, not instantly, and the code also ignores expired touches when picking one.

## Indexes

The delivery queue selects due work in the database with three collection-group queries on `deliveries` (pending oldest-first, retries whose time has come, expired leases). They need the composite indexes in `firestore.indexes.json`; deploy them before running against real Firestore (`firebase deploy --only firestore:indexes` or `gcloud firestore indexes composite create`). The emulator does not enforce indexes, so tests pass without them: a missing index shows up in production as a "needs an index" error with a link to create it.

Other queries (`orderBy(clickedAt, desc)` on touches, `where(personId == ...)` on identities) use automatic single-field indexes.

## Rules

`firestore.rules` denies all client access. Servers use service-account IAM.

## Multi-brand

The code namespaces by `tenantId`. When more brands are added, consider one Firestore database per brand for stronger isolation and simpler deletion (**VERIFY** the current per-project database limit).
