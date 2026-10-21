// Bordered metric strip (ink hairlines, serif numerics). Each cell is a big number + a mono caps label.
// A definition list wants the term first, so the label is the <dt>; CSS puts the number back on top.
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
