'use client';
import { Button, Modal } from '@/components/ui';

export interface SetupCheck {
  ok: boolean;
  checks: Array<{ id: string; label: string; status: 'pass' | 'fail' | 'warn' | 'skip'; detail: string; fix?: string }>;
}

const MARK: Record<SetupCheck['checks'][number]['status'], { symbol: string; tone: string; word: string }> = {
  pass: { symbol: '✓', tone: 'bg-ok-bg text-ok', word: 'passed' },
  fail: { symbol: '✕', tone: 'bg-bad-bg text-bad', word: 'failed' },
  warn: { symbol: '!', tone: 'bg-warn-bg text-warn', word: 'warning' },
  skip: { symbol: '–', tone: 'bg-surface-2 text-muted', word: 'skipped' },
};

export function SetupCheckDialog({ result, onClose }: { result: SetupCheck | null; onClose: () => void }) {
  return (
    <Modal open={result !== null} title={result?.ok ? 'Setup looks good' : 'Something needs fixing'} onClose={onClose} wide>
      {result && (
        <div className="space-y-4">
          <p className="text-sm text-muted">{result.ok ? 'No problems found.' : 'Fix the items marked with a cross, then check again.'}</p>
          <ul className="space-y-3">
            {result.checks.map((x) => (
              <li key={x.id} className="flex items-start gap-3">
                <span role="img" aria-label={MARK[x.status].word} className={`grid h-6 w-6 shrink-0 place-items-center rounded-full text-xs font-bold ${MARK[x.status].tone}`}>{MARK[x.status].symbol}</span>
                <div className="text-sm">
                  <div className="font-semibold">{x.label}</div>
                  <div>{x.detail}</div>
                  {x.fix && <div className="text-muted">What to do: {x.fix}</div>}
                </div>
              </li>
            ))}
          </ul>
          <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Close</Button></div>
        </div>
      )}
    </Modal>
  );
}
