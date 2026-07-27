// Seed weekly-digest artifacts for testing the /weeks routes WITHOUT running the ETL cron.
//
// Builds a StoredReport (the exact shape @sigma/report readStoredReport expects) for one or more ISO
// weeks and writes each to build/weekly-seed/weeks-<iso>.json. Then upload them to R2 with the printed
// `wrangler r2 object put` commands — local (miniflare, for `pnpm --filter @sigma/web dev`) or remote.
//
// Usage:
//   node scripts/seed-weekly-digest.mjs                 # 3 default recent weeks
//   node scripts/seed-weekly-digest.mjs 2026-W25 2026-W24
//
// The routes only read this JSON at serve time (no D1, no LLM), so this fully exercises the render path:
// hero totals, the daily ghost-bar chart, top-10 with entity links, sectors + competition bars, the
// „Разгледай сам" links, the AI watermark, and the provenance footer.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = resolve(ROOT, 'build/weekly-seed');
// Target bucket for the printed upload commands. Override for the shared dev/preview bucket:
//   SIGMA_REPORTS_NAME=sigma-reports-dev node scripts/seed-weekly-digest.mjs
const BUCKET = process.env.SIGMA_REPORTS_NAME || 'sigma-reports';
const DAYS = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Нд'];

// Deterministic pseudo-random from a string, so re-running produces stable numbers per week.
function seeded(str) {
  let h = 2166136261;
  for (const ch of str) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    return ((h >>> 0) % 1000) / 1000;
  };
}

function daySeries(iso, scale) {
  const rnd = seeded(iso);
  return DAYS.map((label) => ({ label, value: Math.round(rnd() * scale) }));
}

function storedReport(iso, asOf) {
  const rnd = seeded(iso);
  const total = 500_000 + Math.round(rnd() * 4_000_000);
  const current = daySeries(iso, total / 4);
  const previous = daySeries(iso + '-prev', total / 4);
  const report = {
    title: `Седмичен обзор — ${iso}`,
    question: 'Седмичен обзор на обществените поръчки в България',
    watermark: 'ai-generated',
    blocks: [
      {
        type: 'text',
        md:
          'През изминалата седмица подписаната стойност се движи осезаемо спрямо предходната. Ритъмът ' +
          'на възлагане остава сравним с обичайния за периода, без рязък скок или срив — движението е ' +
          'по-скоро изместване между сектори, отколкото обща промяна в темпото на харчене.\n\n' +
          'По сектори картината е концентрирана: водещ по обем е строителството, следвано от доставките ' +
          'на оборудване и от услугите. Когато стойността е така струпана в един-два раздела, седмичната ' +
          'сума става чувствителна към малко на брой големи поръчки — един голям инфраструктурен ' +
          'договор може да оформи цялата картина, вместо тя да отразява широка активност.\n\n' +
          'Именно това се вижда и тук: през седмицата се откроява отделен по-голям договор, който тежи ' +
          'осезаемо върху общата стойност. Такива единични поръчки не са необичайни за строителния ' +
          'сектор, но е добре да се разглеждат поотделно, защото изкривяват средните стойности и ' +
          'седмичните сравнения.\n\n' +
          'Картината на конкуренцията е смесена. Част от поръчките са възложени след състезателни ' +
          'процедури, но значителен дял остават с една оферта. Високият дял поръчки с единствен ' +
          'участник е сигнал за проследяване — не присъда — тъй като слабата ценова конкуренция може ' +
          'да се дължи както на специфичен предмет, така и на ограничен кръг изпълнители.\n\n' +
          'Разпределението между възложителите е относително широко, а активността е неравномерна по ' +
          'дни от седмицата — с изразени върхове около средата на работната седмица. Това е типично: ' +
          'подписването често се струпва преди края на отчетни периоди.\n\n' +
          'Обобщено, седмицата е белязана от концентрация в строителството, тежест на отделен голям ' +
          'договор и смесена конкурентна среда. Числата в таблиците и графиките по-долу показват ' +
          'разпределението по дни, сектори и възложители — този анализ е ориентир, а за конкретните ' +
          'стойности разгледайте таблиците и следвайте връзките към първичните записи.',
      },
      {
        type: 'totals',
        items: [
          { label: 'Обща стойност', value: total, format: 'money' },
          { label: 'Договори', value: 40 + Math.round(rnd() * 200), format: 'number' },
          {
            label: 'Промяна спрямо предходната седмица',
            value: rnd() * 0.4 - 0.2,
            format: 'percent',
          },
          { label: 'Най-голяма поръчка', value: Math.round(total * 0.3), format: 'money' },
          { label: 'Дял с една оферта', value: 0.2 + rnd() * 0.3, format: 'percent' },
        ],
      },
      { type: 'weekbars', current, previous },
      {
        type: 'table',
        columns: [
          { key: 'subject', header: 'Предмет', format: 'text' },
          {
            key: 'authority',
            header: 'Възложител',
            format: 'text',
            link: { kind: 'authority', idCol: 'authority_id' },
          },
          {
            key: 'bidder',
            header: 'Изпълнител',
            format: 'text',
            link: { kind: 'company', idCol: 'bidder_id' },
          },
          { key: 'amount', header: 'Стойност', format: 'money' },
        ],
        rows: [
          {
            cells: [
              'Ремонт на път II-86',
              'Министерство на финансите',
              'Пътстрой ЕООД',
              Math.round(total * 0.3),
            ],
            links: [null, 'auth:000695089', 'eik:131234567', null],
          },
          {
            cells: [
              'Доставка на ИТ оборудване',
              'Община Пловдив',
              'Технокар АД',
              Math.round(total * 0.15),
            ],
            links: [null, 'auth:000471504', 'eik:115000000', null],
          },
        ],
      },
      {
        type: 'bar',
        format: 'money',
        points: [
          { label: '45 — Строителство', value: Math.round(total * 0.5) },
          { label: '72 — ИТ услуги', value: Math.round(total * 0.3) },
          { label: '33 — Медицина', value: Math.round(total * 0.2) },
        ],
      },
      {
        type: 'bar',
        format: 'number',
        points: [
          { label: 'С една оферта', value: 30 + Math.round(rnd() * 40) },
          { label: 'С няколко оферти', value: 60 + Math.round(rnd() * 80) },
        ],
      },
      {
        type: 'callout',
        title: 'Как е изчислено',
        md: 'Изчислено от чисти (amount_eur ненулеви) договори за пълна календарна седмица. Сигнали, не присъди.',
      },
    ],
  };
  return {
    stored: {
      schemaVersion: 1,
      id: iso,
      createdAt: `${asOf}T07:00:00.000Z`,
      report,
      provenance: {
        question: report.question,
        sources: [],
        snapshot: [],
        freshness: [{ source: 'admin', asOf }],
        model: 'bggpt-gemma-3-27b-fp8',
        promptVersion: 'weekly-digest-v3',
      },
    },
    total,
  };
}

function isoWeekOf(d) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = x.getUTCDay() || 7;
  x.setUTCDate(x.getUTCDate() + 4 - day);
  const ys = new Date(Date.UTC(x.getUTCFullYear(), 0, 1));
  const w = Math.ceil(((x - ys) / 86400000 + 1) / 7);
  return `${x.getUTCFullYear()}-W${String(w).padStart(2, '0')}`;
}
function recentWeeks(n) {
  const now = new Date();
  const day = now.getUTCDay() || 7;
  const thisMon = new Date(now);
  thisMon.setUTCDate(now.getUTCDate() - (day - 1));
  const out = [];
  for (let i = 1; i <= n; i++) {
    const d = new Date(thisMon);
    d.setUTCDate(thisMon.getUTCDate() - i * 7);
    out.push(isoWeekOf(d));
  }
  return out;
}

const weeks = process.argv.slice(2).length ? process.argv.slice(2) : recentWeeks(3);
mkdirSync(OUT, { recursive: true });

const putCmds = [];
for (const iso of weeks) {
  if (!/^\d{4}-W\d{2}$/.test(iso)) {
    console.error(`skip: '${iso}' is not an ISO week (YYYY-Www)`);
    continue;
  }
  const asOf = new Date().toISOString().slice(0, 10);
  const { stored, total } = storedReport(iso, asOf);
  const file = resolve(OUT, `weeks-${iso}.json`);
  writeFileSync(file, JSON.stringify(stored, null, 2));
  const key = `weeks/${iso}.json`;
  // NOTE: `wrangler r2 object put` cannot set customMetadata, so the /weeks archive lists the seeded
  // weeks but shows „—" for the total (which needs `customMetadata.totalEur`, set by the ETL's
  // persistReport — the real ETL should stay the only source of it). The per-week page /weeks/<iso>
  // renders fully regardless.
  putCmds.push(
    `pnpm --filter @sigma/web exec wrangler r2 object put "${BUCKET}/${key}" --file="${file}" --content-type application/json`,
  );
  console.log(`wrote ${file}  (iso=${iso}, total≈${total})`);
}

console.log(
  `\n# bucket = ${BUCKET}  (override with SIGMA_REPORTS_NAME; preview/dev = sigma-reports-dev)`,
);
console.log('\n# Upload to LOCAL R2 (for `pnpm --filter @sigma/web dev`):');
for (const c of putCmds) console.log(`  ${c} --local`);
console.log('\n# Upload to the REMOTE bucket (needs `wrangler login` to that Cloudflare account):');
for (const c of putCmds) console.log(`  ${c} --remote`);
console.log('\n# Then open  /weeks  and  /weeks/' + (weeks[0] ?? '<iso>'));
console.log('# Clean up a seeded week when done:');
for (const iso of weeks) {
  if (/^\d{4}-W\d{2}$/.test(iso)) {
    console.log(
      `  pnpm --filter @sigma/web exec wrangler r2 object delete "${BUCKET}/weeks/${iso}.json" --remote`,
    );
  }
}
