export const DEFAULT_CONTACT_EMAIL = 'contact@midt.government.bg';

export function contactEmail(env: unknown): string {
  if (typeof env !== 'object' || env === null || !('SIGMA_CONTACT_EMAIL' in env)) {
    return DEFAULT_CONTACT_EMAIL;
  }
  const value = (env as { SIGMA_CONTACT_EMAIL?: unknown }).SIGMA_CONTACT_EMAIL;
  return typeof value === 'string' && value.trim() ? value.trim() : DEFAULT_CONTACT_EMAIL;
}
