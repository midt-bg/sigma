// Sigma read-only query layer — one module per page-section. Aggregates read the precomputed rollup
// tables (home_totals / company_totals / authority_totals / sector_totals / flow_pairs) and the FTS
// search_index; detail pages scope a GROUP BY to a single entity. See docs/v1-implementation-plan.md.

export * from './identity';
export * from './keyset';
export * from './sectors';
export * from './rows';
export * from './home';
export * from './methodology';
export * from './companies';
export * from './authorities';
export * from './contracts';
export * from './flows';
export * from './network';
export * from './trend';
export * from './regions';
export * from './search';
export * from './details';
export * from './sitemaps';
