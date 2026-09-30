export const dynamic = 'force-dynamic';

export async function GET() {
  const version =
    process.env.RENDER_GIT_COMMIT?.trim() ||
    process.env.APP_VERSION?.trim() ||
    'local-development';

  return Response.json(
    { version },
    { headers: { 'Cache-Control': 'no-store, no-cache, must-revalidate' } },
  );
}
