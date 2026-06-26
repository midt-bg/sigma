import type { Route } from './+types/health';
import { buildHealthResponse, pingDb } from '../lib/health';

export async function loader({ context }: Route.LoaderArgs) {
  const db = await pingDb(context.cloudflare.env.DB);
  return buildHealthResponse(db);
}
