import { useEffect, useState } from 'react';
import type { StarterPrompt } from './AssistantEmptyState';

const ENDPOINT = '/assistant/prompts';

// Hard bounds on the untrusted /assistant/prompts body — this is the sole client-side trust boundary.
// The endpoint is meant to return exactly the 4 slots; cap count and per-field length so a corrupted /
// tampered / proxied response can't flood the empty state. Anything over the bound → fall back.
const MAX_PROMPTS = 4;
const MAX_FIELD_CHARS = 300; // a full Bulgarian slot sentence is ~120 chars; 300 is generous headroom

// Narrow an untrusted JSON body to a non-empty StarterPrompt[]. Anything malformed / out-of-bounds →
// undefined so the empty state falls back to its static FALLBACK_PROMPTS.
const parsePrompts = (body: unknown): StarterPrompt[] | undefined => {
  if (typeof body !== 'object' || body === null || !('prompts' in body)) return undefined;
  const { prompts } = body as { prompts: unknown };
  if (!Array.isArray(prompts) || prompts.length === 0 || prompts.length > MAX_PROMPTS) {
    return undefined;
  }
  const out: StarterPrompt[] = [];
  for (const item of prompts) {
    if (
      typeof item !== 'object' ||
      item === null ||
      !('label' in item) ||
      !('send' in item) ||
      typeof item.label !== 'string' ||
      typeof item.send !== 'string' ||
      item.label.length > MAX_FIELD_CHARS ||
      item.send.length > MAX_FIELD_CHARS
    ) {
      return undefined;
    }
    out.push({ label: item.label, send: item.send });
  }
  return out;
};

/**
 * Best-effort fetch of the dynamic starter prompts the weekly etl cron last wrote. Runs once on mount;
 * returns the parsed chips, or `undefined` on any non-2xx / empty / malformed / aborted / failed fetch
 * so the caller falls back to the static FALLBACK_PROMPTS. Aborts in flight on unmount.
 */
export const useStarterPrompts = (): StarterPrompt[] | undefined => {
  const [prompts, setPrompts] = useState<StarterPrompt[] | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await fetch(ENDPOINT, { signal: controller.signal });
        if (!response.ok) return;
        const parsed = parsePrompts(await response.json());
        if (parsed !== undefined) setPrompts(parsed);
      } catch {
        // Best-effort: any failure (abort, network, bad JSON) leaves prompts undefined → fallback.
      }
    })();
    return () => controller.abort();
  }, []);

  return prompts;
};
