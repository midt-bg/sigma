export const ANALYTICS_LENSES = [
  {
    href: '/flows',
    title: 'Потоци',
    desc: 'Накъде текат парите: от възложители към сектори и изпълнители.',
  },
  {
    href: '/map',
    title: 'Карта',
    desc: 'Къде по области се концентрират разходите за обществени поръчки.',
  },
  {
    href: '/trends',
    title: 'Договори — обзор',
    desc: 'Договорите във времето, по CPV код, или двете наведнъж — с типичните цени по група.',
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
