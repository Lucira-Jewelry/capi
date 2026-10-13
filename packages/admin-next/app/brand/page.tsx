import { Suspense } from 'react';
import { BrandPage } from './BrandPage';
import { Skeleton } from '@/components/ui';

// A static export cannot know brand ids ahead of time, so the brand is chosen with ?id=… and read in the browser.
export default function Page() {
  return (
    <Suspense fallback={<Skeleton className="h-64" />}>
      <BrandPage />
    </Suspense>
  );
}
