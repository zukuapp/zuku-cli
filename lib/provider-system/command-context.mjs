import { createProviderRuntime } from './runtime.mjs';

/** Shared runtime for provider/model/auth commands; root may inject `ctx.providerRuntime`. */
export async function runtimeFor(ctx = {}) {
  if (ctx.providerRuntime) return ctx.providerRuntime;
  return createProviderRuntime({
    signal: ctx.signal, stdin: ctx.stdin, stderr: ctx.stderr,
    ...(ctx.environment ? { environment: ctx.environment } : {}),
    ...(ctx.home ? { home: ctx.home } : {}),
    ...(ctx.providerContext ?? {}),
  });
}
export const promptContext = ctx => ({ stdin: ctx.stdin ?? process.stdin, stderr: ctx.stderr ?? process.stderr, signal: ctx.signal, interactive: ctx.interactive });
