'use client';
import { useState } from 'react';
import { Badge, Button, Card, Field, Input, Modal, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import { DEST_LABEL, type SendOverview } from '@/lib/types';

/** The server-wide state of sending, with the operator's pause and resume. */
export function SendingStrip({ initial }: { initial: SendOverview }) {
  const toast = useToast();
  const [s, setS] = useState(initial);
  const [asking, setAsking] = useState(false);
  const { busy, run } = useAction();

  const limits = [s.tenants ? `only for ${s.tenants.join(', ')}` : '', s.destinations ? `only to ${s.destinations.map((d) => DEST_LABEL[d] ?? d).join(', ')}` : ''].filter(Boolean).join(', ');
  const sub = !s.enabled
    ? 'This server is set not to send anything (the OUTBOUND_SENDS setting). Sales are collected and wait.'
    : s.paused
      ? `Paused for every brand${s.reason ? `: ${s.reason}` : ''}. Waiting sales go out when you resume.`
      : `Sales are sent to the ad platforms as they come in${limits ? `, ${limits}` : ''}.`;

  const resume = () =>
    run(async () => {
      setS(await api<SendOverview>('PUT', '/sending', { paused: false }));
      toast('Sending resumed');
    });

  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="font-semibold">Sending</span>
            <Badge tone={!s.enabled ? 'neutral' : s.paused ? 'bad' : 'ok'}>{!s.enabled ? 'Off' : s.paused ? 'Paused' : 'On'}</Badge>
          </div>
          <p className="mt-1 text-sm text-muted">{sub}</p>
        </div>
        {s.enabled && (s.paused ? <Button variant="primary" disabled={busy} onClick={() => void resume()}>Resume sending</Button> : <Button onClick={() => setAsking(true)}>Pause all sending</Button>)}
      </div>
      <PauseDialog open={asking} onClose={() => setAsking(false)} onDone={(next) => { setS(next); toast('Sending paused'); }} />
    </Card>
  );
}

function PauseDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (s: SendOverview) => void }) {
  const [reason, setReason] = useState('');
  const { busy, run } = useAction();
  const submit = async () => {
    const next = await run(() => api<SendOverview>('PUT', '/sending', { paused: true, reason }));
    if (next) {
      setReason('');
      onClose();
      onDone(next);
    }
  };
  return (
    <Modal open={open} title="Pause all sending?" onClose={onClose}>
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }} className="space-y-4">
        <p className="text-sm text-muted">Every instance checks right before each send, so nothing new starts once this is saved. A send already on its way, or one that had just passed its last check, can still complete. Sales keep being collected and go out when you resume.</p>
        <Field label="Reason (optional)" hint="Shown to everyone who opens the console.">
          {(p) => <Input {...p} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. checking a field mapping" />}
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="danger" disabled={busy}>Pause all sending</Button>
        </div>
      </form>
    </Modal>
  );
}
