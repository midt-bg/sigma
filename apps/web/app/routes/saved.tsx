import { Link } from 'react-router';
import { useWatchlist } from '../hooks/useWatchlist';
import { Breadcrumbs } from '../components/Breadcrumbs';
import { PageHeader } from '../components/PageHeader';
import { Section } from '../components/ui';
import { seoMeta } from '../lib/meta';
import type { Route } from './+types/saved';

export function meta({ matches }: Route.MetaArgs) {
  return seoMeta({
    matches,
    path: '/saved',
    title: 'Запазени — СИГМА',
    description: 'Вашият списък за наблюдение на договори, институции и компании.',
  });
}

export default function SavedItems() {
  const { items, removeItem, clearAll } = useWatchlist();

  const companies = items.filter((i) => i.kind === 'company');
  const authorities = items.filter((i) => i.kind === 'authority');
  const contracts = items.filter((i) => i.kind === 'contract');

  const renderSection = (title: string, list: typeof items) => {
    if (list.length === 0) return null;
    return (
      <Section id={list[0].kind} title={`${title} (${list.length})`}>
        <ul className="saved-list">
          {list.map((item) => (
            <li key={item.id} className="saved-item">
              <div className="saved-item-info">
                <Link to={item.href} className="saved-item-title">
                  {item.title}
                </Link>
                <div className="saved-item-sub">{item.subtitle}</div>
              </div>
              <button
                className="saved-item-remove"
                onClick={() => removeItem(item.id)}
                type="button"
                aria-label={`Премахни ${item.title}`}
              >
                ✕ Премахни
              </button>
            </li>
          ))}
        </ul>
      </Section>
    );
  };

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Запазени' }]} />
      <main id="main">
        <PageHeader
          title="Списък за наблюдение"
          lede="Тук се запазват профилите и договорите, които сте маркирали за по-късен преглед. Данните се пазят локално във вашия браузър."
        >
          {items.length > 0 && (
            <button className="source-cta" style={{ marginTop: '16px' }} type="button" onClick={clearAll}>
              Изчисти всички
            </button>
          )}
        </PageHeader>

        {items.length === 0 ? (
          <Section id="empty" title="">
            <div className="blank-slate">
              <p>Все още нямате запазени елементи.</p>
              <p className="muted">
                Използвайте бутона „Запази“ в страниците на договори, институции и компании, за да
                ги добавите тук.
              </p>
            </div>
          </Section>
        ) : (
          <div className="two-col">
            {renderSection('Договори', contracts)}
            {renderSection('Компании', companies)}
            {renderSection('Институции', authorities)}
          </div>
        )}
      </main>
    </>
  );
}
