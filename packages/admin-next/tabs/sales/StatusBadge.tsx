import { Badge } from '@/components/ui';

export function StatusBadge({ status, title }: { status: string; title?: string }) {
  const tone = status === 'sent' || status === 'active' ? 'ok' : status === 'failed' || status === 'error' || status === 'suspended' ? 'bad' : status === 'skipped' ? 'neutral' : 'warn';
  return (
    <span title={title}>
      <Badge tone={tone}>{status}</Badge>
    </span>
  );
}
