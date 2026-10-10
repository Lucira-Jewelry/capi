# Putting the script on a brand's website

The console (brand → Website → **Install script**) shows two ready-to-copy options, built from the brand's real site key,
tracking address and consent setting. Copy the one that fits how the website is managed.

## Option 1: Google Tag Manager

Use this when the brand's tags are managed in Google Tag Manager.

1. In Tag Manager, create a **Tag → Custom HTML** and paste the **Google Tag Manager** code from the console.
2. Trigger: **All Pages** (or the page trigger the brand uses for its other marketing tags). It should fire once per page load.
3. **Remove the previous tracker tag** if there was one, so the script is not loaded twice.
4. Use **Preview** to test on the website, then **Submit / Publish**.

The code is a small loader: it creates the `<script>` element, sets `data-key`, `data-endpoint` (and `data-consent-mode`
for an opt-out brand) on it, and only then adds it to the page.

Why this exists: in one brand's Tag Manager install, the plain script tag loaded `tracker.js` (HTTP 200) but the script
element that ended up on the page had no `data-key`, `data-endpoint` or `data-consent-mode`, so `window.datahash` was
never created. Replacing the tag with this loader fixed it there. The cause of the missing attributes was not
established; this is what was observed, not a statement about how Tag Manager always behaves.

## Option 2: direct installation

Use this when the brand edits its site's pages itself (on Shopify, `theme.liquid`; checkout pages have their own rules,
VERIFY). Paste the **Direct website installation** tag on every page, just before `</head>`:

```html
<script src="https://track.brand.com/tracker.js" data-key="pk_…" data-endpoint="https://track.brand.com" async></script>
```

An opt-out brand's tag also has `data-consent-mode="opt_out"`. An opt-in brand's tag does not (opt-in is the script's
default), so the console never changes a brand's consent behaviour by itself.

## Checking that it works

1. Open the website (with Tag Manager in Preview, or after publishing).
2. In the browser console, type `typeof window.datahash`. It should answer `"object"`. If it says `"undefined"`, the
   script did not start: look at the element in the page's HTML and check it has its `data-key` and `data-endpoint`.
3. When a visitor identifies themselves, the network tab shows a call to `/identify`. A response with `"status":"ok"`
   confirms the identity was stored. A consent or opt-in skip shows as `status: "skipped"` instead.

## What this does and does not prove

- Loading the script, and `window.datahash` being an object, proves the script started with its settings.
- It does **not** prove that sign-ups or logins are captured automatically. The script's form listener looks for forms
  with a phone or email field; one brand's login flow was not detected that way, while calling
  `window.datahash.identify({ email })` by hand worked. Automatic capture for such flows is a separate integration
  (calling `identify` from the brand's own login or sign-up code, or a Tag Manager trigger), not something the loader changes.
- The console's **Check setup** reads the page's HTML, so it cannot see a tag added later by Tag Manager and shows only a
  warning for it. For Tag Manager, use the `typeof window.datahash` check above.
