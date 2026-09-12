import type { PersonActivity } from '@sigma/db';
export const emptyActivity: PersonActivity = {
  contracts: [],
  page: 1,
  pageSize: 50,
  total: 0,
  companyCount: 0,
  valueEur: null,
  roleCount: 0,
  roleEur: null,
  declaredCount: 0,
  declaredEur: null,
  companies: [],
  authorities: [],
  years: [],
  byAuthority: [],
  filters: { company: '', authority: '', year: '', basis: 'role' },
};
