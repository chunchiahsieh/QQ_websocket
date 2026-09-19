export async function POST() {
  return Response.json({ message: '歐博目前暫停服務。' }, { status: 410 });
}
