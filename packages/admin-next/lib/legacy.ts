const TABS = ['overview', 'connections', 'website', 'crm', 'sales', 'settings'];

/**
 * The old console used addresses like /admin/#/brand/<id>/sales. Bookmarks and messages still carry them, so they are
 * translated to the matching page. Import used to be its own address; it is a button under Sales now.
 */
export function legacyTarget(hash: string): string | null {
  const m = /^#\/?brand\/([^/?#]+)(?:\/([^/?#]*))?/.exec(hash);
  if (!m) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1]!);
  } catch {
    return null;
  }
  const tab = m[2] ?? '';
  const wanted = TABS.includes(tab) ? tab : tab === 'import' ? 'sales' : 'overview';
  return `/brand/?id=${encodeURIComponent(id)}&tab=${wanted}`;
}
