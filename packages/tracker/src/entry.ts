import { createTracker, type ConsentState } from './tracker';

// Browser entry: <script src=".../tracker.js" data-key="..." data-endpoint="https://track.brand.com" async></script>
const script = document.currentScript as HTMLScriptElement | null;
const data = script?.dataset ?? {};

if (data.key && data.endpoint) {
  const tracker = createTracker({
    key: data.key,
    endpoint: data.endpoint,
    ...(data.country ? { country: data.country } : {}),
    ...(data.consentMode === 'opt_out' ? { consentMode: 'opt_out' as const } : {}),
    // On by default; data-server-cookie="false" turns the collector-set cookie off.
    serverCookie: data.serverCookie !== 'false',
    // Optional hook: window.datahashConsent = () => 'granted' | 'denied' | 'unknown'
    getConsent: () => {
      const hook = (window as unknown as { datahashConsent?: () => ConsentState }).datahashConsent;
      return hook ? hook() : 'unknown';
    },
  });
  (window as unknown as { datahash: typeof tracker }).datahash = tracker;
}
