import type { ReactNode } from 'react';

// Editorial page header: mono accent kicker + serif h1 (may carry an <em> accent) + lede.
export function PageHeader({
  kicker,
  title,
  titleClassName,
  lede,
  children,
}: {
  kicker?: ReactNode;
  title: ReactNode;
  titleClassName?: string; // size tier for length-aware titles (e.g. long procurement subjects)
  lede?: ReactNode;
  children?: ReactNode; // e.g. a hero search form
}) {
  return (
    <section className="page-header">
      {kicker != null && <p className="kicker">{kicker}</p>}
      <h1 className={titleClassName}>{title}</h1>
      {lede != null && <p className="lede">{lede}</p>}
      {children}
    </section>
  );
}
