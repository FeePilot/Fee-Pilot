import { FeeGuidance } from '@/features/fees/FeeGuidance';
import { Seo } from '@/seo/Seo';

export default function Fees() {
  return (
    <div className="grid gap-6">
      <Seo
        title="Fee guidance"
        description="Fee estimates with their age and source."
        path="/app/fees"
        noindex
      />
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        Fee guidance
      </h1>
      <FeeGuidance />
    </div>
  );
}
