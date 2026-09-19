import { redirect } from 'react-router';
import type { Route } from './+types/conflict.company';
import { companyProfileHref } from '../lib/conflicts';

// The officials with a declared stake in a company are listed on the company's own page.
export function loader({ params }: Route.LoaderArgs) {
  if (!/^\d+$/.test(params.eik ?? '')) throw new Response('Not Found', { status: 404 });
  return redirect(`${companyProfileHref(params.eik)}#declared-people`, 301);
}
