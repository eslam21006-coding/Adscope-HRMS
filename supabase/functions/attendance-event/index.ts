import { createClient } from 'npm:@supabase/supabase-js@2.106.2'

const configuredOrigins = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean)

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('Origin') ?? ''
  const allowedOrigin = configuredOrigins.length === 0
    ? '*'
    : configuredOrigins.includes(origin) ? origin : configuredOrigins[0]

  return {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  }
}

function getPublishableKey(): string {
  const explicit = Deno.env.get('SUPABASE_PUBLISHABLE_KEY')
  if (explicit) return explicit
  const namedKeys = Deno.env.get('SUPABASE_PUBLISHABLE_KEYS')
  if (namedKeys) {
    try {
      const parsed = JSON.parse(namedKeys)
      const first = parsed.default ?? Object.values(parsed)[0]
      if (typeof first === 'string') return first
    } catch {
      // Fall through to the legacy anon key supplied by the runtime.
    }
  }
  return Deno.env.get('SUPABASE_ANON_KEY') ?? ''
}

const allowedTypes = new Set(['CHECK_IN', 'BREAK_START', 'BREAK_END', 'CHECK_OUT'])

function attendanceError(message: string): { code: string; error: string } {
  if (/already have an active attendance shift/i.test(message)) {
    return { code: 'ACTIVE_SHIFT_EXISTS', error: message }
  }
  if (/No active attendance shift/i.test(message)) {
    return { code: 'NO_ACTIVE_SHIFT', error: message }
  }
  if (/needs Owner review/i.test(message)) {
    return { code: 'ATTENDANCE_REVIEW_REQUIRED', error: message }
  }
  if (/attendance is already complete/i.test(message)) {
    return { code: 'ATTENDANCE_ALREADY_COMPLETE', error: message }
  }
  if (/Attendance is not required/i.test(message)) {
    return { code: 'ATTENDANCE_NOT_REQUIRED', error: 'Daily attendance is not required for this employee.' }
  }
  if (/portal access is disabled/i.test(message)) {
    return { code: 'PORTAL_ACCESS_DISABLED', error: 'Employee attendance portal access is disabled.' }
  }
  if (/Authentication required|Authenticated session required/i.test(message)) {
    return { code: 'AUTHENTICATION_REQUIRED', error: 'Your session has expired. Sign in again and retry the attendance action.' }
  }
  if (/current shift state/i.test(message)) {
    return { code: 'ACTION_NOT_AVAILABLE', error: 'This attendance action is not available right now. Refresh the portal and use the available action.' }
  }
  console.error('attendance-event failed:', message)
  return { code: 'ATTENDANCE_ACTION_FAILED', error: 'The attendance action could not be completed. Refresh the portal and try again.' }
}

Deno.serve(async (req: Request) => {
  const headers = corsHeaders(req)
  const requestOrigin = req.headers.get('Origin') ?? ''
  if (configuredOrigins.length > 0 && requestOrigin && !configuredOrigins.includes(requestOrigin)) {
    return Response.json({ code: 'ORIGIN_NOT_ALLOWED', error: 'Origin not allowed' }, { status: 403, headers })
  }
  if (req.method === 'OPTIONS') return new Response('ok', { headers })
  if (req.method !== 'POST') return Response.json({ code: 'METHOD_NOT_ALLOWED', error: 'Method not allowed' }, { status: 405, headers })

  try {
    const authorization = req.headers.get('Authorization')
    if (!authorization?.startsWith('Bearer ')) throw new Error('Authenticated session required')

    const body = await req.json()
    const type = String(body.type || '').toUpperCase()
    const idempotencyKey = String(body.idempotencyKey || '')
    if (!allowedTypes.has(type)) {
      return Response.json({ code: 'INVALID_ATTENDANCE_ACTION', error: 'Invalid attendance action' }, { status: 400, headers })
    }
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyKey)) {
      return Response.json({ code: 'INVALID_REQUEST_ID', error: 'The attendance request could not be prepared. Refresh the portal and try again.' }, { status: 400, headers })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
    const publishableKey = getPublishableKey()
    if (!supabaseUrl || !publishableKey) throw new Error('Supabase function environment is incomplete')

    const supabase = createClient(supabaseUrl, publishableKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const { data, error } = await supabase.rpc('record_attendance_event', {
      p_event_type: type,
      p_idempotency_key: idempotencyKey,
      p_user_agent: req.headers.get('user-agent')?.slice(0, 500) ?? null,
    })
    if (error) throw error
    return Response.json(data, { status: 200, headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error'
    const response = attendanceError(message)
    return Response.json(response, { status: response.code === 'AUTHENTICATION_REQUIRED' ? 401 : 400, headers })
  }
})
