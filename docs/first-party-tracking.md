# First-party tracking: the brand's own tracking address

## What it is, and what it is not

A brand can point its own address (for example `track.brand.com`) at our collector. The website script is then loaded from, and talks to, that address, so the browser treats it as part of the brand's own site.

It is only the **browser → collector** leg. Sending to Meta and Google always happens **server to server, from our servers**; the ad platforms never see the brand's address.

```
brand page ──(track.brand.com)──▶ our collector ──▶ Firestore
                                        │ later, when a sale arrives
                                        └──(server to server)──▶ Meta / Google
```

## What the brand's address gives us

1. **A cookie set by our server, on the brand's own address.** When a visitor lands from an ad (and has consented), the script asks `/touch` to remember the click. The collector answers with a signed cookie: `HttpOnly`, `SameSite=Lax`, host-only, lifetime = the brand's retention. It is signed so it cannot be edited in the browser. **Nothing is stored in our database**: the cookie lives in the visitor's browser, and the server only reads it back when the visitor later identifies themselves (phone or email) through the same address.
2. **A second copy of the click.** The script keeps its own copy in browser storage too. At identify time we use both (the same click in both places counts once, with the earlier time), so clearing one does not lose the click.
3. **Fewer losses to blockers** that target third-party tracking domains. VERIFY against real blockers.

## What it does NOT promise (be honest with brands)

- **Safari's 7-day limit may still apply.** Safari caps the lifetime of cookies set by a server reached through a CNAME to someone else's infrastructure, and may also cap it when the server's IP address does not match the brand's own site. A CNAME to our collector is probably in that category, so the cookie may still last only about 7 days in Safari. **VERIFY on real Safari before promising anything.** The reliable fix, if it matters, is for the brand to route a path of its own domain (for example `brand.com/track/*`) to our collector through its own CDN or proxy, which makes the requests same-origin and the server on the brand's own IP range. The collector would work behind such a proxy unchanged, because it keys on the `Host` it is given.
- It does not recover clicks for visitors who never identify themselves, or who switch device or browser.
- Chrome and Firefox do not cap first-party cookies the same way, so the benefit there is mostly the second copy and fewer blocked requests.

## The DNS record, exactly (for `track.lucirajewelry.com`)

| Type | Name / Host | Value / Points to |
|---|---|---|
| CNAME | `track` (some panels want the full `track.lucirajewelry.com`) | our collector's public hostname (the host in `PUBLIC_URL`) |

- That one record is all the address itself needs. **No TXT record is needed for it.**
- The name must have no other records (a CNAME cannot share a name with an A, MX or TXT record). If the domain is on Cloudflare, set the record to "DNS only".
- The console shows this table for each site key, with the exact target. It refuses to call it ready while `PUBLIC_URL` is still `localhost`.
- A TXT record or an extra CNAME (for example `_acme-challenge.track`) may be required later **by the certificate method we choose at deployment**. That is not decided yet, so it is not shown; when it is chosen the console will show it here as well.

## How the brand's website knows to use it

Only through the script tag, which the brand pastes into its pages before `</head>` (on Shopify, `theme.liquid`; checkout pages have their own rules, VERIFY). Both the file and the data go to the address in the tag:

```html
<script src="https://track.lucirajewelry.com/tracker.js" data-key="pk_…" data-endpoint="https://track.lucirajewelry.com" async></script>
```

Nothing else on the site changes. If the tag is loaded through Google Tag Manager, paste the same tag as a custom HTML tag.

## "Check setup" (console → brand → Website → the site key)

Runs from our server and tests, in the order things usually break:

| Check | Passes when | If it fails |
|---|---|---|
| DNS record | the name is a CNAME to our collector (or resolves to the same addresses, if the DNS provider flattens it) | says what the name points to instead, or that it does not exist yet |
| HTTPS and routing | `https://track…/trackcheck` answers with a valid certificate, directly (no redirect), from our collector, which recognises the site key and this exact address | tells a certificate problem (ours to fix) from a DNS problem from a wrong saved address |
| Script file | `/tracker.js` loads as JavaScript | |
| Permission for the website | the brand's site is allowed to talk to the address with cookies (catches a CDN stripping headers) | |
| First-party cookie | a test click makes the collector set the HttpOnly (and Secure, on HTTPS) cookie. Nothing is stored on our side | explains a missing `X-Forwarded-Proto` or an unrecognised address |
| Script tag on the website | the tag with this key is in the HTML of the brand's pages | only a warning: a tag added later by Google Tag Manager is not visible in the HTML |

Items that depend on the address being reachable are skipped, not failed, until it is. The check refuses to contact private or loopback addresses, so it cannot be used to probe a private network. A check that passes here proves our server can reach the address; it does not prove the visitors' browsers can (a DNS record that has not spread yet, a corporate filter). The final proof is always opening the brand's site and watching `tracker.js` load from the tracking address.

## Setting it up for a brand

1. Console → brand → **Website** → the site key → **Tracking address**: enter `track.brand.com` and save. The console shows the DNS record to give the brand (a `CNAME` from that name to our collector's host), and the script tag that uses the address.
2. The brand adds the DNS record.
3. **The server must serve HTTPS for that name.** Nothing in this repository provisions the certificate yet; it is a deployment task (a managed certificate on the load balancer, Cloudflare for SaaS, or Caddy with on-demand TLS). Until HTTPS works for the name, the brand must not use the new tag.
4. The brand pastes the new script tag. The script's `data-server-cookie="false"` turns the cookie off if ever needed.

Rules the collector enforces:
- The cookie is only set when the request arrives **on that brand's tracking address** (`Host` header) from one of the brand's allowed sites, and consent allows it (opt-in brands need an explicit yes).
- On the shared product address there is no first-party cookie; the answer is `skipped` and the script relies on browser storage, as before.
- A site key's tracking address must be unique. Withdrawing consent through that address also clears the cookie.
- Cookies are signed with `COOKIE_SECRET` (default: derived from `SECRETS_KEY`). Changing it makes existing cookies unreadable (clicks held only in cookies are lost; browser copies remain).

## Testing it end to end on your machine

```sh
docker compose up -d firestore
npm run build && npm run dev                                   # the collector, http://localhost:8787
FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/demo-site.ts    # a pretend brand site
```
Open the printed link in **Chrome** (it resolves `*.localhost` to your machine; Safari may not). The page is `http://brand.localhost:9000` and the tracking address is `track-xxxx.brand.localhost:8787`: two different hostnames, as in real life.

1. Land with `?gclid=…&fbclid=…`: nothing is stored until you press **Accept**.
2. After Accept, the "What is stored in this browser" panel shows the click both in browser storage and as held by the server's HttpOnly cookie.
3. Submit the enquiry (phone and email): the person is created with the click.
4. Press **Simulate a store purchase**: the demo's "CRM" calls the brand's webhook.
5. In the console (brand → **Sales**) press **Preview** on a delivery: it shows exactly what would be sent to Meta and Google (the credited click, `fbc`, hashed contact details), without sending anything.
6. **Withdraw consent** clears the browser copies and the server cookie, and suppresses the customer.

## What is verified, and what is not

Verified in tests and in Chrome on two `*.localhost` hostnames: the cookie is set only on the tracking address, is read back at identify, is signed (tampered or expired cookies are ignored), is cleared on withdrawal, CORS with credentials works, and the click reaches the payload preview.

Not verified: real DNS and certificates, Safari's behaviour (lifetime caps), Firefox, ad blockers, and the cookie behaviour behind a real CDN or proxy.
