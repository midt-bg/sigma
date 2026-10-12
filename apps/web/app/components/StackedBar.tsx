import type { ProcedureSlice } from '@sigma/api-contract';
import { count, pct, plural } from '@sigma/shared';

// Procedure-mix bar („Как купува / Как печели") — CSS flex segments + a legend, no chart library.
// Colours are the @sigma/config group tokens (ink ramp; accent red marks the non-competitive bucket).
// By value (the default) each segment is its share of the money and the legend says it as a percentage;
// by contracts each segment is its share of the contracts and the legend gives the count, so the page's one
// direct-award percentage (with its own stated base) is not met by a second one on another base.
export function StackedBar({
  slices,
  basis = 'value',
}: {
  slices: ProcedureSlice[];
  basis?: 'value' | 'contracts';
}) {
  const byCount = basis === 'contracts';
  const share = (s: ProcedureSlice) => (byCount ? s.contractSharePct : s.sharePct);
  const visible = slices.filter((s) => (byCount ? s.contracts > 0 : s.sharePct >= 0.0005));
  if (visible.length === 0) return null;
  const caption = (s: ProcedureSlice) =>
    byCount
      ? `${count(s.contracts)} ${plural(s.contracts, 'договор', 'договора')}`
      : pct(s.sharePct);
  return (
    <>
      <div className="hbar" aria-hidden="true">
        {visible.map((s) => (
          <span
            key={s.key}
            style={{
              width: `${Math.min(100, Math.max(0, share(s) * 100)).toFixed(1)}%`,
              background: s.color,
            }}
            title={`${s.label} — ${caption(s)}`}
          />
        ))}
      </div>
      <div className="hbar-legend">
        {visible.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label} · {caption(s)}
          </span>
        ))}
      </div>
    </>
  );
}
