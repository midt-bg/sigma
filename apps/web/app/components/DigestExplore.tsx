import { Link } from 'react-router';

// „Разгледай сам" (spec §3.10): code-generated deep links (NEVER AI) from the digest into the
// interactive surfaces, so a reader can leave the fixed weekly template and explore the same data
// themselves. Rendered by the /weeks/:iso route, not emitted as a report block.
//
// NOTE: the list routes don't yet accept a `?week=` filter, so these point at the full exploration
// surfaces rather than a week-scoped slice. Tracked as a follow-up in docs/tickets/167b (#81 review,
// note 4): when a `week` filter lands on the contracts/authorities/companies loaders, thread `iso`
// into these hrefs.
const LINKS: { to: string; label: string; hint: string }[] = [
  {
    to: '/contracts?sort=date-desc',
    label: 'Всички договори',
    hint: 'Пълният списък, най-новите отгоре',
  },
  { to: '/authorities', label: 'Институции', hint: 'Кой възлага и колко харчи' },
  { to: '/companies', label: 'Компании', hint: 'Кой печели поръчките' },
  { to: '/flows', label: 'Потоци на парите', hint: 'От институция към изпълнител' },
];

export function DigestExplore({ iso }: { iso: string }) {
  return (
    <section className="digest-explore" aria-labelledby="digest-explore-h">
      <h2 id="digest-explore-h">Разгледай сам</h2>
      <p className="small muted">
        Обзорът за {iso} е фиксиран шаблон. Продължи навътре в данните през интерактивните изгледи:
      </p>
      <ul className="digest-explore-list">
        {LINKS.map((l) => (
          <li key={l.to}>
            <Link to={l.to}>{l.label}</Link>
            <span className="small muted"> — {l.hint}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
