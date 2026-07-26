// Minimal stand-in for workerd's 'cloudflare:workers' built-in so plain vitest can import the
// Workflow module (vitest.config.ts aliases the built-in here; `tsc` keeps using the real
// @cloudflare/workers-types declarations). Mirrors only what src/index.ts touches: the entrypoint
// base class carrying ctx + env.
export class WorkflowEntrypoint<Env = unknown, _Params = unknown> {
  protected ctx: ExecutionContext;
  protected env: Env;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export interface WorkflowEvent<T> {
  payload: Readonly<T>;
  timestamp: Date;
  instanceId: string;
}

export interface WorkflowStep {
  do<T>(name: string, callback: () => Promise<T>): Promise<T>;
  do<T>(name: string, config: Record<string, unknown>, callback: () => Promise<T>): Promise<T>;
}
