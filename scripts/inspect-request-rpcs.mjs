import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const sql = readFileSync('supabase/migrations/20260812102000_compiled_attendance_session_portal.sql', 'utf8');
const parts = [...sql.matchAll(/values \('attendance',\d+,\$payload\$([\s\S]*?)\$payload\$/g)].map(match => match[1]);
if (!parts.length) throw new Error('No attendance bundle parts found');
const encoded = parts.join('');
const html = gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8');
for (const name of ['submit_permission_request','submit_leave_request','submit_advance_request','submit_violation_response']) {
  const index = html.indexOf(name);
  console.log(`\n===== ${name} =====`);
  if (index < 0) {
    console.log('NOT FOUND');
    continue;
  }
  console.log(html.slice(Math.max(0, index - 700), Math.min(html.length, index + 1400)));
}
