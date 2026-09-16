import { redirect } from 'react-router';
import type { Route } from './+types/conflict.official';

// The office-holder's page lives at /persons/:id; the earlier address keeps working.
export function loader({ params, request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  return redirect(`/persons/${encodeURIComponent(params.id)}${url.search}${url.hash}`, 301);
}
