// Dev-only diagnostic for the assistant dock. Compiled out of production builds: Vite replaces
// `import.meta.env.DEV` with `false`, so the call becomes dead code and is dropped by minification.
// A single seam to route to client telemetry later, if the app ever adds it.
export const devWarn = (message: string, error?: unknown): void => {
  if (import.meta.env.DEV) {
    console.warn(message, ...(error === undefined ? [] : [error]));
  }
};
