/**
 * Read an API response that is expected to be JSON without masking a proxy's
 * plain-text error page as "Unexpected token ... is not valid JSON".
 */
export async function readJsonResponse<T extends Record<string, unknown>>(response: Response): Promise<T> {
  const raw = await response.text();
  if (!raw.trim()) return {} as T;
  try {
    return JSON.parse(raw) as T;
  } catch {
    const message = raw.replace(/\s+/g, ' ').trim().slice(0, 240);
    return { message: message || `服務回應格式錯誤（HTTP ${response.status}）。` } as unknown as T;
  }
}
