import type { ProcedureSlice } from '@sigma/api-contract';
import { pct } from '@sigma/shared';
import { useLocale } from '../i18n/context';

// Procedure-mix bar („Как купува / Как печели") — CSS flex segments + a legend, no chart library.
// Colours are the @sigma/config group tokens (ink ramp; accent red marks the non-competitive bucket).
export function StackedBar({ slices }: { slices: ProcedureSlice[] }) {
  const locale = useLocale();
  const visible = slices.filter((s) => s.sharePct >= 0.0005);
  if (visible.length === 0) return null;
  return (
    <>
      <div className="hbar" aria-hidden="true">
        {visible.map((s) => (
          <span
            key={s.key}
            style={{
              width: `${Math.min(100, Math.max(0, s.sharePct * 100)).toFixed(1)}%`,
              background: s.color,
            }}
            title={`${s.label} — ${pct(s.sharePct, undefined, locale)}`}
          />
        ))}
      </div>
      <div className="hbar-legend">
        {visible.map((s) => (
          <span key={s.key}>
            <i style={{ background: s.color }} />
            {s.label} · {pct(s.sharePct, undefined, locale)}
          </span>
        ))}
      </div>
    </>
  );
}
