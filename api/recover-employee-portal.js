import { gunzipSync } from 'node:zlib';

export default async function handler(req, res) {
  try {
    const sourceUrl = 'https://raw.githubusercontent.com/eslam21006-coding/Adscope-HRMS/abeab0843dc18b437f0fab234797847dd47f1bf3/supabase/migrations/20260812102000_compiled_attendance_session_portal.sql';
    const response = await fetch(sourceUrl, { cache: 'no-store' });
    if (!response.ok) throw new Error(`GitHub returned ${response.status}`);
    const sql = await response.text();
    const match = sql.match(/\$payload\$([A-Za-z0-9+/=\r\n]+)\$payload\$/);
    if (!match) throw new Error('Historical payload was not found');
    const payload = match[1].replace(/\s+/g, '');
    const html = gunzipSync(Buffer.from(payload, 'base64')).toString('utf8');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Recovered-Payload-Length', String(payload.length));
    res.status(200).send(html);
  } catch (error) {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Recovery failed' });
  }
}
