// Shown instead of zeros and „no results“ when nothing has been loaded into the database at all — a list
// nobody filtered that is empty, a home page with no totals. Without it an empty database reads as real,
// zero-valued data. The public wording tells a visitor it is a data gap, not a finding; the setup steps are
// for a developer and only exist in a dev build (import.meta.env.DEV is replaced at build time, so a
// production bundle carries none of it).
export function EmptyDataNotice() {
  return (
    <div className="callout warning" role="status">
      <h2>Все още няма заредени данни</h2>
      <p>
        Порталът не разполага с данни за обществените поръчки в момента, затова няма какво да
        покажем. Това не означава, че поръчки не са възлагани — данните просто още не са заредени
        или обновяването е в ход. Опитайте отново по-късно.
      </p>
      {import.meta.env.DEV && (
        <p className="small" data-testid="empty-data-dev-hint">
          <strong>Локална среда:</strong> базата е празна. Изпълнете <code>pnpm run setup</code> за
          малкия примерен набор или <code>pnpm run import</code> за пълния корпус (виж README, „Бърз
          старт“).
        </p>
      )}
    </div>
  );
}
