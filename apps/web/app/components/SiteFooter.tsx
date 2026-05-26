import { Link } from "react-router";
import { date } from "@sigma/shared";

// Single mono-caps line: source + coverage window + freshness date. `asOf` is the data current-as-of
// date from the root loader (home_totals); omitted gracefully when unavailable (e.g. an error page).
export function SiteFooter({ asOf }: { asOf?: string | null }) {
  return (
    <footer className="site-footer" role="contentinfo">
      <div className="site-footer-inner">
        <span>
          Източник: АОП / ЦАИС ЕОП · 2020–2026{asOf ? ` · обновени ${date(asOf)}` : ""}
        </span>
        <Link to="/methodology">Методология</Link>
      </div>
    </footer>
  );
}
