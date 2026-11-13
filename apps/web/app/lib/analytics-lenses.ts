export const ANALYTICS_LENSES = [
  {
    href: '/trends',
    title: 'Тренд',
    desc: 'Как се движат разходите във времето по месеци и години.',
  },
  {
    href: '/map',
    title: 'Карта',
    desc: 'Къде по области се концентрират разходите за обществени поръчки.',
  },
  {
    href: '/flows',
    title: 'Потоци',
    desc: 'Накъде текат парите: от възложители към сектори и изпълнители.',
  },
  {
    href: '/competition',
    title: 'Конкуренция',
    desc: 'Къде има висок дял „една оферта“ и концентрация на доставчици.',
  },
] as const;

export const ANALYTICS_NAV_PATHS = [
  '/analytics',
  ...ANALYTICS_LENSES.map((lens) => lens.href),
  '/network',
] as const;
