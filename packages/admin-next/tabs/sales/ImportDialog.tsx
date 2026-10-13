'use client';
import { useState, type FormEvent } from 'react';
import { Button, Field, Modal, Textarea, useAction, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { download, plural } from './format';
import type { ImportCheck, ImportSummary } from './types';

/** What a clean check found, in plain words, as the confirmation shown before anything is imported. */
export function ImportSummaryView({ sm, optIn }: { sm: ImportSummary; optIn: boolean }) {
  const money = Object.entries(sm.value).map(([cur, n]) => `${cur} ${n.toLocaleString('en-IN')}`).join(' + ');
  const lines: Array<{ text: string; warn?: boolean }> = [];
  if (sm.alreadyImported) lines.push({ text: `${plural(sm.alreadyImported, 'row is', 'rows are')} already imported and will be skipped.` });
  if (money) lines.push({ text: `Total value of the new sales: ${money}` });
  if (sm.firstDate) lines.push({ text: sm.firstDate === sm.lastDate ? `Sale date: ${sm.firstDate}` : `Sale dates: ${sm.firstDate} to ${sm.lastDate}` });
  if (sm.newSales !== 0) {
    lines.push(
      sm.withoutContact
        ? { text: `${plural(sm.withoutContact, 'row has', 'rows have')} no phone or email. They are recorded but cannot be matched, so they will not be sent.`, warn: true }
        : { text: 'Every row has a phone or an email.' },
    );
    const risky = Boolean(sm.consent.notStated && optIn);
    lines.push({
      text: `Consent: ${sm.consent.yes} yes, ${sm.consent.no} no, ${sm.consent.notStated} not stated.${risky ? ' Without a yes, a sale is only sent if the customer agreed on the website.' : ''}${sm.consent.no ? ' Rows marked no are never sent.' : ''}`,
      warn: risky,
    });
  }
  if (sm.withName || sm.withPostalCode) lines.push({ text: `Better matching: ${plural(sm.withName, 'row has', 'rows have')} a full name, ${plural(sm.withPostalCode, 'row has', 'rows have')} a postal code.` });
  return (
    <div role="status" className="rounded-lg bg-surface-2 px-3 py-2.5 text-sm">
      <strong>{sm.newSales === 0 ? 'Nothing new to import.' : `Ready to import ${plural(sm.newSales, 'sale', 'sales')}.`}</strong>
      <ul className="mt-1.5 list-disc space-y-1 pl-5">
        {lines.map((l) => (
          <li key={l.text} className={l.warn ? 'text-warn' : undefined}>{l.text}</li>
        ))}
      </ul>
    </div>
  );
}

type Passed = { csv: string; token: string; summary: ImportSummary };

/**
 * The import is only offered for a file that has just passed the check, and any edit to the file undoes that:
 * the first press checks (nothing is imported), the second imports exactly the checked file.
 */
export function ImportDialog({ tenantId, columns, template, optIn, onClose, onImported }: { tenantId: string; columns: string[]; template: string; optIn: boolean; onClose: () => void; onImported: () => void }) {
  const toast = useToast();
  const { busy, run } = useAction();
  const [csv, setCsv] = useState('');
  const [passed, setPassed] = useState<Passed | null>(null);
  const [problems, setProblems] = useState<ImportCheck['results'] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const edit = (value: string) => {
    setCsv(value);
    setPassed(null);
    setProblems(null);
    setFailure(null);
  };

  const readFile = (f: File) =>
    new Promise<string>((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result ?? ''));
      r.onerror = () => reject(r.error);
      r.readAsText(f);
    });

  const check = async () => {
    const r = await api<ImportCheck>('POST', `/tenants/${encodeURIComponent(tenantId)}/import`, { csv, dryRun: true });
    const bad = r.results.filter((x) => x.status === 'invalid' || x.status === 'error');
    if (bad.length || !r.checkToken || !r.summary) {
      setPassed(null);
      setProblems(bad);
    } else {
      setProblems(null);
      setPassed({ csv, token: r.checkToken, summary: r.summary });
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    await run(async () => {
      // Always against the file as it is now: if it changed since the check, check again instead of importing.
      if (!passed || passed.csv !== csv) return check();
      if (passed.summary.newSales === 0) return onClose(); // nothing to add: just close
      try {
        const r = await api<ImportCheck>('POST', `/tenants/${encodeURIComponent(tenantId)}/import`, { csv: passed.csv, checkToken: passed.token });
        const { recorded = 0, error = 0, invalid = 0 } = r.counts;
        if (error > 0 || invalid > 0) {
          setFailure(`Recorded ${recorded}, but ${plural(error + invalid, 'row failed', 'rows failed')}. Check the Sales tab.`);
          setPassed(null);
          onImported();
          return;
        }
        toast(`Imported ${plural(recorded, 'sale', 'sales')}.`);
        onImported();
        onClose();
      } catch (err) {
        if (err instanceof ApiError && (err.code === 'check_outdated' || err.code === 'check_required')) {
          setPassed(null); // the check expired: ask for a new one
          toast('The check has expired. Check the file again.', true);
          return;
        }
        throw err;
      }
    });
  };

  const label = !passed ? 'Check file' : passed.summary.newSales === 0 ? 'Close' : `Import ${plural(passed.summary.newSales, 'sale', 'sales')}`;

  return (
    <Modal open title="Import sales" onClose={onClose} wide>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm text-muted">For sales that are missing from the CRM. Only import sales that are not already coming from it, or they will be counted twice. The file is checked first; nothing is imported until it passes.</p>
        <div className="flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            aria-label="Choose a CSV file"
            className="text-sm"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) edit(await readFile(f));
            }}
          />
          <button type="button" className="text-sm text-accent underline" onClick={() => download('sales-template.csv', template)}>Download a template</button>
        </div>
        <Field label="Or paste the file contents" hint="Needs eventId, channel (store, online, whatsapp or web_lead) and occurredAt (a date like 2026-10-07).">
          {(p) => <Textarea {...p} rows={7} spellCheck={false} placeholder={columns.join(',')} value={csv} onChange={(e) => edit(e.target.value)} />}
        </Field>
        <div aria-live="polite" className="space-y-2">
          {problems && (
            <div role="alert" className="rounded-lg bg-bad-bg px-3 py-2.5 text-sm text-bad">
              <div>{plural(problems.length, 'row has', 'rows have')} problems. Fix them and check again; nothing can be imported until the file passes.</div>
              <ul className="mt-1.5 list-disc pl-5">
                {problems.slice(0, 20).map((x) => (
                  <li key={x.line}>Line {x.line}: {x.error ?? x.status}</li>
                ))}
              </ul>
              {problems.length > 20 && <div className="mt-1 text-xs">…and {problems.length - 20} more.</div>}
            </div>
          )}
          {failure && <div role="alert" className="rounded-lg bg-bad-bg px-3 py-2.5 text-sm text-bad">{failure}</div>}
          {passed && <ImportSummaryView sm={passed.summary} optIn={optIn} />}
        </div>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" disabled={busy || (!passed && !csv.trim())}>{label}</Button>
        </div>
      </form>
    </Modal>
  );
}
