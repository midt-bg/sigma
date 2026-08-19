// Boundary adapters between the Worker's generated binding types (worker-configuration.d.ts) and
// the assistant's narrowed structural types (rag.ts). This is the ONE module allowed to know both
// sides — everything else depends on the structural types only (issue #316).
//
// VECTORIZE needs no adapter: VectorizeIndex is structurally assignable to VectorIndex, and the
// route's plain assignment is the compile-time proof. Only AI needs bridging, because Ai.run() is
// typed per-model (generic overloads) and returns an output UNION that cannot satisfy
// EmbeddingRunner directly.

import { EMBED_MODEL, type EmbeddingRunner } from './rag';

/**
 * Wrap the Workers AI binding as the assistant's EmbeddingRunner. The call goes through the real
 * `@cf/baai/bge-m3` overload (the `model` parameter is typed as that literal end-to-end), so the
 * request shape stays compiler-checked — no `as unknown as`, ever.
 */
export function embeddingRunnerFor(ai: Ai): EmbeddingRunner {
  return {
    run: async (model, inputs) => {
      const out = await ai.run(model, { text: inputs.text });
      // `data.length > 0` too, not just presence: an empty `data: []` is truthy and would read as
      // "success" here for a NON-empty input (embed() never calls the adapter with empty texts) —
      // the inverse failure of the missing-key case, named separately for the operator (review
      // f/u, ydimitrof). embed()'s count check would still throw, but with a message that blames
      // "0 embeddings" instead of the real cause: a provider that answered with an empty batch.
      if ('data' in out && Array.isArray(out.data) && out.data.length > 0) {
        return { data: out.data };
      }
      // Preserve the diagnostic a blind cast used to lose: name the unexpected shape. KEYS ONLY —
      // an error envelope could echo the embedded input, and user text must not land in logs.
      const shape =
        'data' in out && Array.isArray(out.data)
          ? 'празен data масив за непразен вход'
          : `ключове: ${Object.keys(out).join(', ') || 'няма'}`;
      throw new Error(`embeddings: неочаквана форма на отговора от ${EMBED_MODEL} (${shape})`);
    },
  };
}
