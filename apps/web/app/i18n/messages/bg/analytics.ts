export const analytics = {
  metaTitle: 'Анализи — СИГМА',
  metaDescription:
    'Четири аналитични изгледа към обществените поръчки: потоци, карта, тренд и конкуренция.',
  breadcrumbHome: 'Начало',
  breadcrumbAnalytics: 'Анализи',
  kicker: 'Анализи',
  title: 'Анализи',
  lede: 'Четири начина да проследиш едни и същи обществени поръчки: като движение на пари, карта, времева линия и сигнал за слаба конкуренция.',
  lensesTitle: 'Изгледи',
  lensesHint:
    'Всеки изглед отговаря на различен въпрос, но всички водят обратно към конкретните договори.',
  lensKicker: 'Изглед',
  viewLink: 'Виж {lens} →',
  contracts: '{count} договора',
  // Flows lens preview
  flowsPreviewTitle: 'Най-големи национални потоци',
  flowsEmpty: 'Няма достатъчно данни за потоци.',
  // Map lens preview
  mapPreviewTitle: 'Водещи области по стойност',
  mapEmpty: 'Няма достатъчно данни по области.',
  // Trends lens preview
  trendsPreviewTitle: 'Годишен национален тренд',
  trendsCurrentYear: 'Текуща година',
  trendsLatestYear: 'Последна година',
  trendsPartial: 'частично',
  trendsPeak: 'Пик',
  trendsEmpty: 'Няма достатъчно данни за тренд.',
  // Competition lens preview
  competitionPreviewTitle: 'Национален дял с една оферта',
  competitionTopConcentrationPre: 'Най-концентриран възложител: ',
  competitionTopConcentrationIndex: '(индекс {index})',
  // Lens cards
  lens: {
    flows: {
      title: 'Потоци',
      desc: 'Накъде текат парите: от възложители към сектори и изпълнители.',
    },
    map: {
      title: 'Карта',
      desc: 'Къде по области се концентрират разходите за обществени поръчки.',
    },
    trends: {
      title: 'Тренд',
      desc: 'Как се движат разходите във времето по месеци и години.',
    },
    competition: {
      title: 'Конкуренция',
      desc: 'Къде има висок дял „една оферта“ и концентрация на доставчици.',
    },
  },
} as const;
