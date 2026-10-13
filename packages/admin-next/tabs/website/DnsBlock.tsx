'use client';
import type { SiteKey } from '@/lib/types';
import { More, StepTitle } from './util';

/** What to ask whoever manages the brand's domain: shown once an address is saved, as the next step. */
export function DnsBlock({ site }: { site: SiteKey }) {
  const dns = site.dns;
  if (!dns) return <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">Save the address to see the DNS record to add.</div>;
  if (dns.local) return <div className="rounded-lg bg-surface-2 px-3 py-2 text-sm text-muted">This is a local test name: it needs no DNS record.</div>;
  return (
    <div className="space-y-3">
      <StepTitle>Next: ask whoever manages the domain to add this record</StepTitle>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-left text-sm">
          <thead className="bg-surface-2 text-xs uppercase text-muted">
            <tr>{['Type', 'Name', 'Points to'].map((x) => <th key={x} scope="col" className="px-3 py-2 font-medium">{x}</th>)}</tr>
          </thead>
          <tbody>
            <tr>
              <td className="px-3 py-2">{dns.type}</td>
              <td className="px-3 py-2 font-mono text-xs">{dns.short}</td>
              <td className="px-3 py-2 font-mono text-xs">{dns.target}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted">It can take a few minutes to a few hours to appear. If the domain is on Cloudflare, set it to “DNS only”. Full name: {dns.name}.</p>
      {!dns.ready && (
        <div role="alert" className="rounded-lg bg-bad-bg px-3 py-2 text-sm text-bad">Not ready to hand out: this server does not know its own public address yet (it is “{dns.target}”). Set PUBLIC_URL first.</div>
      )}
      <More summary="Also needed on our side">
        <p className="text-xs text-muted">Our server needs a certificate for this name. That is set up by us when the name is added to the server, not by the brand.</p>
      </More>
    </div>
  );
}
