'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { Button, Field, Input, Modal, useAction, useToast } from '@/components/ui';
import { api } from '@/lib/api';
import type { ZohoMapping } from '@/lib/types';
import { More, csvToList } from '../website/util';
import { MAPPING_FIELDS, type MappingField } from './fields';

const toText = (m: Partial<ZohoMapping> | undefined): Record<string, string> =>
  Object.fromEntries(
    MAPPING_FIELDS.map((f) => {
      const v = m?.[f.key];
      return [f.key, Array.isArray(v) ? v.join(', ') : ((v as string | undefined) ?? '')];
    }),
  );

export function MappingDialog({ tenantId, open, current, usual, onClose, onSaved }: { tenantId: string; open: boolean; current: ZohoMapping | undefined; usual: ZohoMapping; onClose: () => void; onSaved: () => Promise<void> }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [values, setValues] = useState<Record<string, string>>(() => toText(current));
  useEffect(() => {
    if (open) setValues(toText(current));
  }, [open, current]);

  const row = (f: MappingField) => (
    <Field key={f.key} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.hint}>
      {(p) => <Input {...p} value={values[f.key] ?? ''} onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))} />}
    </Field>
  );

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const body: Record<string, unknown> = {};
    for (const f of MAPPING_FIELDS) {
      const raw = (values[f.key] ?? '').trim();
      if (!raw) continue;
      body[f.key] = f.list ? csvToList(raw) : raw;
    }
    const done = await run(async () => {
      await api('PUT', `/tenants/${encodeURIComponent(tenantId)}/sources/zoho`, body);
      return true;
    });
    if (done) {
      toast('Mapping saved');
      onClose();
      await onSaved();
    }
  };

  return (
    <Modal open={open} title="Zoho field mapping" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-sm text-muted">Type the exact field names (API names) from Zoho. Fields with * are needed.</p>
        <div className="grid gap-4 sm:grid-cols-2">{MAPPING_FIELDS.filter((f) => f.required).map(row)}</div>
        <More summary="More fields (optional)">
          <div className="grid gap-4 sm:grid-cols-2">{MAPPING_FIELDS.filter((f) => !f.required).map(row)}</div>
        </More>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            className="text-sm text-accent underline"
            onClick={() => {
              setValues(toText(usual));
              toast('Filled in. Check the names against Zoho, then save.');
            }}
          >
            Fill with usual names
          </button>
          <div className="flex gap-2">
            <Button onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" disabled={busy}>Save mapping</Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
