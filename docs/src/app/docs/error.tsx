'use client';

import { useEffect } from 'react';

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error('[docs] Route error', error);
  }, [error]);

  return (
    <div className="p-6 space-y-4">
      <h2 className="text-lg font-semibold">Something went wrong</h2>
      <p className="text-sm text-fd-muted-foreground">
        We could not render this documentation page.
      </p>
      <button
        type="button"
        className="px-3 py-2 rounded-md border text-sm"
        onClick={() => reset()}
      >
        Try again
      </button>
    </div>
  );
}

