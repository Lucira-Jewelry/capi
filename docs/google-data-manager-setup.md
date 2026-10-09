# Sending to Google Ads with the Data Manager API

The product sends sales to Google Ads through the **Data Manager API** (`events:ingest`). The older Google Ads `uploadClickConversions` route is retired and is not used.

Everything below comes from Google's current documentation (Data Manager API: "Send events", "Format user data", diagnostics). Items marked **VERIFY** are the ones to confirm on a real account.

## Two ways to log in to a brand's Google Ads account

You pick one per brand in the console (Ad accounts → Google Ads → "How do we log in to this account?"). Both use the same Data Manager API and the same Google Cloud project.

| | Service account (recommended) | OAuth refresh token |
|---|---|---|
| What the brand does | Adds your service account's email as a user on its Google Ads account, or links the account to your manager (MCC) account | A Google user with access to the account signs in once and approves your app |
| Stored per brand | Nothing secret | An encrypted refresh token |
| Google review | None. Google's docs say app verification does not apply when only service accounts are used for automated work | Required before production: the `datamanager` scope is sensitive, so the OAuth app must be verified (consent screen, demo video). Until then only the test users you list can approve it |
| Server needs | `GOOGLE_SERVICE_ACCOUNT_JSON` (or `_FILE`) | `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` |

A server can have both configured, and brands can mix them.

## One-time setup (the product owner, once)

1. In the Google Cloud project that has Data Manager API access, **enable the Data Manager API**.
2. **Service account route:** create a service account in that project, create a JSON key for it, and give the server the key's text in `GOOGLE_SERVICE_ACCOUNT_JSON` (or a file path in `GOOGLE_SERVICE_ACCOUNT_FILE`). Keep the key out of the repository. The console then shows the account's email, ready to copy for each brand.
3. **OAuth route (optional):** create an OAuth client (a "Desktop app" client works with `scripts/google-refresh-token.ts`) and set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`. No developer token is needed.

## For each brand

1. In the brand's Google Ads account, create a **conversion action** of type **Import from clicks** (shown as *Website, import from clicks*; the API calls it `UPLOAD_CLICKS`). Note its numeric ID. The account you send to must own the action.
2. **Service account route:** the brand adds the service account's email as a user (Admin → Access and security), or links its account to your manager account. Google's documentation mentions an "Account access setup" step for service accounts on Google Ads: **VERIFY** what it requires on a test account. Then in the console choose *Service account*, enter the customer ID, the manager ID if you reach the account through one, and the conversion action ID.
   **OAuth route:** run `GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npx tsx scripts/google-refresh-token.ts`, open the link, sign in as a user with access to the account, approve, and paste the printed refresh token (scope `https://www.googleapis.com/auth/datamanager`) into the console.
3. Press **Check connection**. It asks Google to validate a sample event with `validateOnly`, which sends nothing. It catches: no access to the account, API not enabled for the project, wrong scope, wrong conversion action type. If the service account has not been given access yet, the error says exactly which email the brand must add.

## What gets sent

One event per sale, with:

| Field | Value |
|---|---|
| `eventTimestamp` | the real sale time (UTC) |
| `transactionId` | the sale's stable ID. The same on every retry, and what Google uses to deduplicate |
| `eventSource` | `IN_STORE` for store sales, `MESSAGE` for WhatsApp, `WEB` for online and web leads |
| `conversionValue`, `currency` | when the sale has a value |
| `adIdentifiers` | one of `gclid`, `gbraid`, `wbraid`, from the click credited to the sale |
| `userData` | SHA-256 hashes (hex) of the email and phone, normalised by Google's rules (Gmail: dots and `+suffix` removed; phone in E.164) |
| `consent.adUserData` | `CONSENT_GRANTED` only when the sale carries an explicit yes. `adPersonalization` is left unspecified, not guessed |

`gbraid`/`wbraid` clicks are sent without `userData` for now (**VERIFY**: Google's current reference does not say whether the two may be combined).

## Accepted is not processed

Google answers an upload immediately with a **request ID**, then processes it for between 30 minutes and 24 hours. The product keeps the request ID and asks Google for the result (`requestStatus:retrieve`): first after 30 minutes, then backing off ×1.3 up to 60 minutes, giving up after 24 hours. The console shows each Google delivery as *Accepted, Google is still processing it*, *Processed by Google*, *Partly rejected* or *Rejected by Google* with the reasons (for example `INVALID_CONVERSION_ACTION_TYPE`, `EVENT_TIME_INVALID`). A rejected sale can be fixed and resent: the same transaction ID is reused.

## Before real traffic (VERIFY on a test account)

- Run **Check connection**, then send one real test sale and watch it go from *accepted* to *processed*.
- Confirm the accepted time window for old events. The product assumes 90 days from the click (or from the sale when there is no click), which is an assumption, not a documented Google limit.
- Confirm whether `gbraid`/`wbraid` may carry user data, and whether `adPersonalization` should be sent for your customers.
- Confirm the API limits (requests per minute and day) for your project. The product sends one event per request today; Google allows up to 2,000 per request, so batching is the next step when volume grows.
- A new conversion action may take time before value updates and matching are fully active; Google's guide mentions a 14-day trial for value updates on matching transaction IDs.
