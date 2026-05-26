// Bordered metric strip (ink hairlines, serif numerics). Each cell is a big number + a mono caps label.
export interface Total {
  num: string;
  label: string;
}

export function TotalsStrip({ totals, label }: { totals: Total[]; label?: string }) {
  return (
    <dl className="totals" aria-label={label}>
      {totals.map((t, i) => (
        <div className="cell" key={i}>
          <span className="num">{t.num}</span>
          <span className="label">{t.label}</span>
        </div>
      ))}
    </dl>
  );
}
