import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  index('routes/home.tsx'),
  route('search', 'routes/search.tsx'),
  route('flows', 'routes/flows.tsx'),
  route('companies', 'routes/companies.tsx'),
  route('companies.csv', 'routes/companies.csv.tsx'),
  route('companies/:eik', 'routes/company.tsx'),
  route('authorities', 'routes/authorities.tsx'),
  route('authorities.csv', 'routes/authorities.csv.tsx'),
  route('authorities/:eik', 'routes/authority.tsx'),
  route('contracts', 'routes/contracts.tsx'),
  route('contracts.csv', 'routes/contracts.csv.tsx'),
  route('contracts/:id.json', 'routes/contract.json.tsx'),
  route('contracts/:id', 'routes/contract.tsx'),
  route('methodology', 'routes/methodology.tsx'),
] satisfies RouteConfig;
