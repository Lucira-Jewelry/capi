/**
 * Onboard a brand:
 *   FIRESTORE_EMULATOR_HOST=localhost:8080 npx tsx scripts/create-tenant.ts "Brand Name" https://www.brand.com [--zoho]
 *
 * Prints the site key (for the website script) and the webhook secret (shown once).
 */
import { createFirestore, TenantRegistry } from '@datahash/store';
import { DEFAULT_ZOHO_MAPPING } from '@datahash/ingest';
import { installSnippets } from '@datahash/server';

const [name, origin, ...flags] = process.argv.slice(2);
if (!name) {
  console.error('usage: create-tenant.ts "Brand Name" [https://www.brand.com] [--zoho]');
  process.exit(1);
}

const registry = new TenantRegistry(createFirestore());
const { tenant, siteKey, webhookSecret } = await registry.createTenant({
  name,
  origins: origin ? [origin] : [],
  ...(flags.includes('--zoho') ? { zoho: DEFAULT_ZOHO_MAPPING } : {}),
});

const host = process.env.PUBLIC_URL ?? 'https://track.example.com';
const snippets = installSnippets({ trackerUrl: `${host}/tracker.js`, key: siteKey, endpoint: host, consentMode: tenant.consentPolicy.mode });
console.log(`
Tenant:          ${tenant.tenantId}
Site key:        ${siteKey}
Website script:  ${snippets.script}
Google Tag Manager (Custom HTML tag):
${snippets.gtm}
Webhook URL:     ${host}/webhooks/${tenant.tenantId}/zoho   (or /generic)
Webhook secret:  ${webhookSecret}   <- shown once; send as header x-webhook-secret
${flags.includes('--zoho') ? '\nZoho mapping uses DEFAULT field names. Set the brand\'s real ones with registry.setSourceMapping().' : ''}`);
