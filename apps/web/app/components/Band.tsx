import type { ReactNode } from 'react';

// A content band in the „technical dossier" grid: a 220px rail carrying „Раздел NN" over a
// coloured subtitle, then the content. Bands are separated by hairline bottom borders.
//
// The rail is presentational chrome — the section's real heading lives in the body and is what
// `aria-labelledby` points at — so the rail text is hidden from assistive tech to avoid
// announcing „Раздел 03 Конкуренция" twice. On mobile (<=960px) the rail collapses and the label
// reads as one horizontal row above the section (see industry.css).
export function Band({
  no,
  title,
  risk = false,
  split = false,
  labelledBy,
  children,
}: {
  /** Section number, e.g. „Раздел 03". */
  no: string;
  /** Rail subtitle, e.g. „Конкуренция". */
  title: string;
  /** Competition/risk sections label in red — the one place red is used as chrome. */
  risk?: boolean;
  /** Three-column variant (rail + two equal content columns). */
  split?: boolean;
  /** id of the heading inside `children` that names this section. */
  labelledBy?: string;
  children: ReactNode;
}) {
  return (
    <section className={`band${split ? ' band-split' : ''}`} aria-labelledby={labelledBy}>
      <div className="band-rail" aria-hidden="true">
        <span className="rail-no">{no}</span>
        <span className={`rail-title${risk ? ' is-risk' : ''}`}>{title}</span>
      </div>
      {children}
    </section>
  );
}

/** The content cell of a Band. Use one per column (two for `split`). */
export function BandBody({ children }: { children: ReactNode }) {
  return <div className="band-body">{children}</div>;
}

/** The four „+" registration marks of a `.blueprint` frame. Decorative. */
export function Corners() {
  return (
    <>
      <i className="corner tl" aria-hidden="true" />
      <i className="corner tr" aria-hidden="true" />
      <i className="corner bl" aria-hidden="true" />
      <i className="corner br" aria-hidden="true" />
    </>
  );
}
