'use client';
import { Button, Modal } from '@/components/ui';
import type { SiteKey } from '@/lib/types';
import { InstallOptions } from './InstallOptions';
import { CodeBlock, More } from './util';

export function InstallDialog({ site, onClose }: { site: SiteKey | null; onClose: () => void }) {
  return (
    <Modal open={site !== null} title="Install the script" onClose={onClose} wide>
      {site && (
        <div className="space-y-5">
          <p className="text-sm text-muted">Choose how this website is set up. Nothing else on the site needs to change.</p>
          <InstallOptions site={site} />
          <More summary="Does the website have a cookie banner?">
            <p className="text-sm text-muted">Tell the script when the visitor agrees or declines, so nothing is stored or sent without consent:</p>
            <CodeBlock>{"// from your cookie banner\nwindow.datahash.setConsent(true);   // or false\n\n// or let the script ask the banner\nwindow.datahashConsent = () => 'granted'; // 'denied' | 'unknown'"}</CodeBlock>
          </More>
          <div className="flex justify-end"><Button variant="primary" onClick={onClose}>Done</Button></div>
        </div>
      )}
    </Modal>
  );
}
