/**
 * Get a refresh token for a brand's Google Ads user, with the Data Manager scope.
 *
 *   GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npx tsx scripts/google-refresh-token.ts
 *
 * Needs an OAuth client of type "Desktop app" (or a web client with http://localhost:8788/callback as a redirect URI)
 * in the Google Cloud project that has the Data Manager API enabled. Open the printed link, sign in as the Google user
 * who has access to the brand's Google Ads account, and approve. Paste the printed token into the brand's
 * "Ad accounts" tab in the console. The token is shown once and not stored anywhere by this script.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { exchangeGoogleCode, googleAuthUrl } from '@datahash/senders';

const clientId = process.env.GOOGLE_CLIENT_ID;
const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET first.');
  process.exit(1);
}

const port = Number(process.env.PORT ?? 8788);
const redirectUri = `http://localhost:${port}/callback`;
const state = randomBytes(16).toString('hex');

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', redirectUri);
  if (url.pathname !== '/callback') {
    res.writeHead(404).end();
    return;
  }
  const code = url.searchParams.get('code');
  if (url.searchParams.get('state') !== state || !code) {
    res.writeHead(400, { 'content-type': 'text/plain' }).end('Missing code or wrong state. Start again.');
    return;
  }
  const result = await exchangeGoogleCode(code, redirectUri, { clientId, clientSecret });
  res.writeHead(200, { 'content-type': 'text/plain' }).end(result.ok ? 'Done. You can close this tab and go back to the terminal.' : `Failed: ${result.error}`);
  console.log(result.ok ? `\nRefresh token (shown once):\n\n${result.refreshToken}\n` : `\nFailed: ${result.error}\n`);
  server.close();
});

server.listen(port, () => {
  console.log(`\nOpen this link and approve access:\n\n${googleAuthUrl({ clientId }, redirectUri, state)}\n\nWaiting on ${redirectUri} ...`);
});
