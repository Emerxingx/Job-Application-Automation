import { Card } from '@/components/ui';

export default function IntegrationsLoading() {
  return (
    <div aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading your integrations…</span>

      <header className="mb-6">
        <div className="h-8 w-44 animate-pulse rounded-lg bg-raised" />
        <div className="mt-2.5 h-4 w-96 max-w-full animate-pulse rounded bg-raised" />
      </header>

      <div className="space-y-8">
        {[0, 1].map((section) => (
          <div key={section}>
            <div className="mb-3 h-6 w-40 animate-pulse rounded bg-raised" />
            <div className="space-y-3">
              {[0, 1].map((index) => (
                <Card key={index} className="p-4">
                  <div className="h-4 w-52 max-w-full animate-pulse rounded bg-raised" />
                  <div className="mt-2.5 h-3 w-40 max-w-full animate-pulse rounded bg-raised" />
                  <div className="mt-3 flex gap-1.5">
                    <div className="h-5 w-16 animate-pulse rounded-lg bg-raised" />
                    <div className="h-5 w-20 animate-pulse rounded-lg bg-raised" />
                  </div>
                </Card>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
