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

  return (
    <>
      <Breadcrumbs items={[{ label: 'Начало', to: '/' }, { label: 'Запазени' }]} />
      <main id="main">
        <PageHeader
          title="Списък за наблюдение"
          lede="Тук се запазват профилите и договорите, които сте маркирали за по-късен преглед. Данните се пазят локално във вашия браузър."
        >
          {items.length > 0 && (
            <div style={{ marginTop: '16px' }}>
              <button className="btn" type="button" onClick={clearAll}>
                Изчисти всички
              </button>
            </div>
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
            {contracts.length > 0 && (
              <Section id="contracts" title={`Договори (${contracts.length})`}>
                <div>
                  {contracts.map((item) => (
                    <div key={item.id} className="saved-item">
                      <Link to={item.href} className="saved-item-title">
                        {item.title}
                      </Link>
                      <div className="saved-item-sub">{item.subtitle}</div>
                      <div className="saved-item-actions">
                        <button
                          className="btn-link muted small"
                          onClick={() => removeItem(item.id)}
                          type="button"
                        >
                          Премахни
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {companies.length > 0 && (
              <Section id="companies" title={`Компании (${companies.length})`}>
                <div>
                  {companies.map((item) => (
                    <div key={item.id} className="saved-item">
                      <Link to={item.href} className="saved-item-title">
                        {item.title}
                      </Link>
                      <div className="saved-item-sub">{item.subtitle}</div>
                      <div className="saved-item-actions">
                        <button
                          className="btn-link muted small"
                          onClick={() => removeItem(item.id)}
                          type="button"
                        >
                          Премахни
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {authorities.length > 0 && (
              <Section id="authorities" title={`Институции (${authorities.length})`}>
                <div>
                  {authorities.map((item) => (
                    <div key={item.id} className="saved-item">
                      <Link to={item.href} className="saved-item-title">
                        {item.title}
                      </Link>
                      <div className="saved-item-sub">{item.subtitle}</div>
                      <div className="saved-item-actions">
                        <button
                          className="btn-link muted small"
                          onClick={() => removeItem(item.id)}
                          type="button"
                        >
                          Премахни
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}
          </div>
        )}
      </main>
    </>
  );
}
