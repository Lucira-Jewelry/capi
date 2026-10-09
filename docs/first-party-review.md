# First-party domain and setup-check review

Historical review. See [current checklist status](checklist-status.md) for verified fixes to cookie sizing/retention, network protection, CORS/tag checks, outbound sending and disconnected waits.

Reviewed 9 October 2026. Scope: current domain configuration, setup checker, HTTP routing, tracker cookie integration, and existing Zoho-to-platform pilot readiness. No application logic or cloud resources were changed.

## Decision

The setup checker is implemented and useful for onboarding, but a green result is not yet reliable evidence of browser readiness. Keep the one-brand trial to synthetic Zoho store purchases until the outstanding deployment and privacy gates in `staging-readiness.md` pass. The earlier first-party cookie-size and retention findings remain reproducible.

## Validation

- **359 tests across 36 files passed** with the existing Firestore emulator and local HTTP listeners; none skipped.
- Type checking and tracker/admin builds passed.
- Platform calls remain mocked in tests; no real ad-platform uploads were made.
- Read-only public DNS checks for the documented hostname `track.lucirajewelry.com` returned `ENOTFOUND` for CNAME and A queries; HTTPS lookup also returned `ENOTFOUND`. This is an observation at review time, not confirmation about another hostname or future DNS propagation.

## Implemented and covered

- Per-site tracking hostname, validation, uniqueness check, origin configuration, and generated script/DNS instructions.
- Admin-authenticated POST setup check, operator UI with per-check results and fixes, and public `/trackcheck` routing diagnostics.
- CNAME/address comparisons, TLS/routing diagnosis, tracker-file retrieval, CORS-header check, cookie-header check, and website HTML inspection.
- Signed host-only cookie; HttpOnly, SameSite=Lax, Secure on HTTPS; credentialed `/touch`, `/identify`, and withdrawal calls.
- Click read-back and deduplication into identified customers; payload preview helps inspect later Zoho purchase deliveries without sending.

## Findings requiring attention

| Priority | Finding | Reproduced evidence / fix |
|---|---|---|
| High before public cloud use | Private-network protection is incomplete | `isPrivateAddress('::ffff:127.0.0.1')` returns false. DNS is checked with `lookup`, then `fetch` resolves again, leaving a rebinding gap. Normalize mapped IPv6, reject nonpublic addresses and unsupported URL schemes, and pin the verified destination while preserving TLS hostname validation. The `.localhost` exception should be restricted to an explicit development mode in GCP. Current admin authentication limits access, but does not make the network restriction complete. |
| High for first-party reliability | No server-cookie byte budget | Five accepted `/touch` requests with valid maximum-length fields produce a **12,570-byte cookie name/value**, HTTP 200. Trim optional fields/touches to a safe serialized byte budget before signing. A count limit of five does not enforce a cookie size limit. |
| High before real customer testing | Retention differs from brand setting | A 60-day-old click is accepted by `/touch` for a tenant with 30-day retention. `/identify` applies a fixed 400-day cookie-click filter; later writes renew cookie expiry without pruning to tenant retention. Apply the configured retention consistently on read, merge, and write. |
| Medium | CORS check can report a false pass | A synthetic OPTIONS response with HTTP 503 and matching allow-origin/credentials headers is reported as `pass`. Require a successful status and relevant allowed method/header values. Verify actual POST/read behavior too: the current server OPTIONS response echoes Origin without looking up a site key. |
| Medium | Website tag check can report a false pass | HTML containing the key only in a paragraph is reported as an installed script tag. Parse the script element and verify `data-key`, `src`, and `data-endpoint` against the expected tracking host. Retain the warning path for GTM-injected tags; use a browser/network check for their final verification. |
| Medium | Cookie check verifies a header, not round-trip use | It does not replay the cookie into identify, validate all attributes/size, or test browser SameSite acceptance. Check header attributes and a synthetic round trip without persisting a person, then perform the actual brand-browser smoke test. |
| High before real customer testing | Withdrawal after reload still cannot suppress a known customer without contact | The cookie is cleared, but it holds clicks only. `lastContact` remains memory-only; `/consent` is not called without contact, and notification has no retry. Supply an acknowledged stable identity/contact withdrawal integration. Cookie deletion alone does not suppress already queued Zoho purchases. |

The checker also does not establish that website and tracking hostname share the same registrable domain. A syntactically valid unrelated hostname can pass server-side checks while browser SameSite rules prevent the intended cookie flow. Confirm the actual HTTPS site relationship and test the browser, rather than treating `trackingHost` as proof by itself.

## Remaining GCP pilot gates

The production packaging/start command is still missing; `npm run build` builds only the two frontends. Real Firestore indexes/TTL, stable secrets and IAM, HTTPS/custom-host routing, scheduler configuration, outbound-send controls, brand destination access, and staged-data cleanup remain deployment tasks. Disconnected deliveries still consume the claim limit even though they do not consume send attempts.

Use Meta test events and Google validate-only checks first. Ordinary Google dispatch is live ingestion. Restrict the first pilot to one consented store Purchase source and one Google conversion action. The full acceptance sequence is in `staging-readiness.md`.

## Next verification

1. Fix the network restriction and the first-party size/retention/withdrawal issues.
2. Strengthen checker assertions, including regression cases for the false passes above.
3. Configure the actual tracking DNS and HTTPS route, preserving the external Host and trusted HTTPS forwarding.
4. Run Check setup from the deployed staging service, then verify cookie storage/read-back on the brand's real browser session and inspect the linked Zoho purchase payload preview.
5. Complete controlled Meta/Google delivery and processing checks before enabling scheduled real-customer sends.
