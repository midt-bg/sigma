import { Link } from 'react-router';
import { errorCopy } from '../lib/error-copy';
import { AccessibilityWidget } from './AccessibilityWidget';
import { PageHeader } from './PageHeader';
import { ScrollToTop } from './ScrollToTop';
import { SiteFooter } from './SiteFooter';
import { SiteHeader } from './SiteHeader';

// The root error boundary's page (root.tsx): a 404/500 inside the site chrome, so it still looks like
// СИГМА and keeps the nav, the footer and the accessibility widget.
export function ErrorPage({ error }: { error: unknown }) {
  const { kicker, title, lede, documentTitle } = errorCopy(error);
  const stack = import.meta.env.DEV && error instanceof Error ? error.stack : undefined;

  return (
    <>
      {/* The boundary bypasses route `meta`, so set the document title here (React hoists it). */}
      <title>{documentTitle}</title>
      <a className="skip" href="#main">
        Към съдържанието
      </a>
      <SiteHeader />
      <main id="main">
        <PageHeader kicker={kicker} title={title} lede={lede} />
        <p className="muted">
          <Link to="/">Начало</Link> · <Link to="/companies">Компании</Link> ·{' '}
          <Link to="/authorities">Институции</Link> · <Link to="/contracts">Договори</Link>
        </p>
        {stack && (
          <pre className="mono small error-stack">
            <code>{stack}</code>
          </pre>
        )}
      </main>
      <SiteFooter />
      {/* An error page is where a saved contrast theme or font size matters most; keep the widget. */}
      <ScrollToTop />
      <AccessibilityWidget />
    </>
  );
}
