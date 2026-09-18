// Bordered metric strip (ink hairlines, serif numerics). Each cell is a big number + a mono caps label.
export interface Total {
  num: string;
  label: string;
}

export function TotalsStrip({ totals, label }: { totals: Total[]; label?: string }) {
  return (
    <dl className="totals" aria-label={label}>
      {totals.map((t) => (
        <div className="cell" key={t.label}>
          <dt className="label">{t.label}</dt>
          <dd className="num">{t.num}</dd>
        </div>
      ))}
    </dl>
  );
}
