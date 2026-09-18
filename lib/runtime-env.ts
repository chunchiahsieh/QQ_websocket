// Read deployment secrets from both Node and Cloudflare Worker runtimes.
// Wrangler exposes Render variables as Worker bindings rather than
// process.env, so API routes must use this small compatibility layer.
import { env as workerEnv } from 'cloudflare:workers';

export const runtimeEnv = (name: string): string | undefined => {
  const nodeValue = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (typeof nodeValue === 'string' && nodeValue.length > 0) return nodeValue;
  const workerValue = (workerEnv as Record<string, unknown> | undefined)?.[name];
  return typeof workerValue === 'string' && workerValue.length > 0 ? workerValue : undefined;
};
