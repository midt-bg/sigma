// Runtime stub for the `cloudflare:workers` module, which the Workers runtime provides but vitest's node
// environment cannot resolve (ERR_MODULE_NOT_FOUND). Aliased in vitest.config.ts. Node tests import the
// worker entry (workers/app.ts) for its fetch handler; that entry re-exports the assistant Durable Object
// classes, which `extends DurableObject` at class-definition time. The DO classes are NEVER instantiated
// in node tests, so an empty base class is all that's needed to let the modules load. Types come from the
// real @cloudflare/workers-types at typecheck (wrangler types), independent of this runtime alias.
export class DurableObject {}
