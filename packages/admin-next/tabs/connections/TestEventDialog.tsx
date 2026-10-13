'use client';
import { Button, Modal } from '@/components/ui';
import type { MetaTestResult } from '@/lib/types';

/** What happened to the test event, and exactly where to look for it in Events Manager. */
export function TestEventDialog({ result, onClose }: { result: MetaTestResult | null; onClose: () => void }) {
  return (
    <Modal open={result !== null} title={result?.ok ? 'Test event sent' : 'Test event not sent'} onClose={onClose}>
      {result && (
        <div className="space-y-4">
          <p role="status" className={`rounded-lg px-3 py-2 text-sm ${result.ok ? 'bg-ok-bg text-ok' : 'bg-bad-bg text-bad'}`}>{result.message}</p>
          {result.ok && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
              <dt className="text-muted">Dataset</dt>
              <dd className="font-mono">{result.datasetId}</dd>
              <dt className="text-muted">Test code</dt>
              <dd className="font-mono">{result.testEventCode}</dd>
              <dt className="text-muted">Meta replied</dt>
              <dd className="break-all font-mono text-xs">{result.detail}</dd>
            </dl>
          )}
          {result.ok && <p className="text-xs text-muted">The event is a made-up purchase of 1 INR, sent with your test event code so Meta treats it as a test. Where Meta shows it is up to Meta, so check Test Events in Events Manager.</p>}
          <div className="flex justify-end"><Button onClick={onClose}>Close</Button></div>
        </div>
      )}
    </Modal>
  );
}
