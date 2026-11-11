// CORS + JSON helpers shared by every Edge Function.

export const corsHeaders: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-supabase-api-version',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Max-Age': '86400',
}

export class HttpError extends Error {
  status: number
  code?: string
  extra?: Record<string, unknown>
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.extra = extra
  }
}

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  })
}

export function errorResponse(status: number, error: string, code?: string, extra?: Record<string, unknown>): Response {
  return json({ error, code, ...(extra ?? {}) }, status)
}

export async function readJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T
  } catch {
    throw new HttpError(400, 'Invalid JSON body', 'bad_json')
  }
}

/** Wrap a handler: answers CORS preflight, converts thrown HttpError/Error into JSON responses. */
export function serve(handler: (req: Request) => Promise<Response>): void {
  Deno.serve(async (req) => {
    if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
    try {
      return await handler(req)
    } catch (e) {
      if (e instanceof HttpError) return errorResponse(e.status, e.message, e.code, e.extra)
      console.error('[unhandled]', e)
      return errorResponse(500, e instanceof Error ? e.message : String(e), 'internal')
    }
  })
}

/** Run work after the response is sent (Supabase Edge Runtime), falling back to fire-and-forget. */
export function background(p: Promise<unknown>): void {
  const guarded = p.catch((e) => console.error('[background]', e))
  // deno-lint-ignore no-explicit-any
  const rt = (globalThis as any).EdgeRuntime
  if (rt?.waitUntil) rt.waitUntil(guarded)
}
