// The production deployment runs with Vinext's Node server on Render. Keep
// deployment secrets in the Node environment instead of importing the
// Cloudflare-only `cloudflare:workers` module: that import crashes API routes
// when the same build is started on a normal Render Web Service.
export const runtimeEnv = (name: string): string | undefined => {
  const nodeValue = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  return typeof nodeValue === 'string' && nodeValue.length > 0 ? nodeValue : undefined;
};
