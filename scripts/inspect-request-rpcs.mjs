const supabaseUrl = 'https://fazvuuwgahuxacvgyslf.supabase.co';
const key = 'sb_publishable_F7S5nEal7qghrczR7v0k8A_6GEPMbDq';
const names = ['submit_permission_request','submit_leave_request','submit_advance_request','submit_violation_response'];

for (const name of names) {
  const response = await fetch(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: {
      apikey: key,
      'Content-Type': 'application/json',
      Accept: 'application/json'
    },
    body: '{}'
  });
  console.log(`\n===== ${name} =====`);
  console.log('status:', response.status);
  console.log(await response.text());
}
