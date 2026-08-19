import { describe, expect, it, vi } from 'vitest';
import { embeddingRunnerFor } from './bindings';
import { EMBED_MODEL } from './rag';

// The adapter is the ONLY hand-written logic between the Worker's Ai binding and embed(); a fake
// binding pins its behaviour (a blind cast had none to pin — review note on #316). The stub is
// cast because tests fake the boundary; production code never casts (that is the point of #316).
function fakeBinding(out: Record<string, unknown>) {
  const run = vi.fn(async () => out);
  return { ai: { run } as unknown as Ai, run };
}

describe('embeddingRunnerFor', () => {
  it('forwards the model literal and the texts into the real binding call', async () => {
    const { ai, run } = fakeBinding({ data: [[0.1], [0.2]] });
    const out = await embeddingRunnerFor(ai).run(EMBED_MODEL, { text: ['а', 'б'] });
    expect(out).toEqual({ data: [[0.1], [0.2]] });
    expect(run).toHaveBeenCalledWith(EMBED_MODEL, { text: ['а', 'б'] });
  });

  it('throws a named, keys-only error on a non-embedding response shape', async () => {
    // bge-m3 can answer with query-scoring or async envelopes; the adapter must not silently
    // return [] (that reads as "provider embedded nothing") and must not log payload content.
    const { ai } = fakeBinding({ response: [{ id: 0, score: 0.5 }] });
    await expect(embeddingRunnerFor(ai).run(EMBED_MODEL, { text: ['а'] })).rejects.toThrow(
      /неочаквана форма.*ключове: response/,
    );
  });

  it('throws with "няма" when the response has no keys at all', async () => {
    const { ai } = fakeBinding({});
    await expect(embeddingRunnerFor(ai).run(EMBED_MODEL, { text: ['а'] })).rejects.toThrow(
      /ключове: няма/,
    );
  });

  it('rejects an EMPTY data array for a non-empty input instead of reading [] as success', async () => {
    // `[]` is truthy: a presence-only check would return { data: [] } and embed()'s count error
    // would then blame "0 embeddings" instead of the real cause — a provider answering with an
    // empty batch. The adapter names that case explicitly (review f/u, ydimitrof).
    const { ai } = fakeBinding({ data: [] });
    await expect(embeddingRunnerFor(ai).run(EMBED_MODEL, { text: ['а'] })).rejects.toThrow(
      /празен data масив/,
    );
  });
});
