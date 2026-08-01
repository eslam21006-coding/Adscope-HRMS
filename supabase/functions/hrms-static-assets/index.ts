import { createClient } from 'npm:@supabase/supabase-js@2.106.2'

function secretKey() {
  const direct = Deno.env.get('SUPABASE_SECRET_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (direct) return direct

  const named = Deno.env.get('SUPABASE_SECRET_KEYS')
  if (named) {
    try {
      const parsed = JSON.parse(named)
      const value = parsed.default ?? Object.values(parsed)[0]
      if (typeof value === 'string') return value
    } catch {}
  }
  return ''
}

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type',
  'Cross-Origin-Resource-Policy': 'cross-origin',
}

function decodeBase64(value: string) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}

function encodeBase64(bytes: Uint8Array) {
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length))
    binary += String.fromCharCode(...chunk)
  }
  return btoa(binary)
}

async function gunzipBase64(payload: string) {
  const bytes = decodeBase64(payload)
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
  return await new Response(stream).text()
}

async function gzipBase64(text: string) {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))
  const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  return encodeBase64(bytes)
}

const EMPLOYEE_PORTAL_URL = 'https://portal.adscope.net/'

const EMPLOYEE_SAVE_ORDER_MARKER = '<!-- data-adscope-employee-save-order="valid-state-v1" -->'
const EMPLOYEE_SAVE_ORDER_BLOCK = String.raw`      let employeeId;
      try {
        const selectedShift = fd.get('current_shift_id') || null;
        const compensationChanged = isNew || [
          String(fd.get('compensation_type')) !== String(employee?.compensation_type),
          num(fd.get('basic_salary')) !== num(employee?.basic_salary),
          String(fd.get('payroll_currency')) !== String(employee?.payroll_currency),
          num(fd.get('default_commission_rate')) !== num(employee?.default_commission_rate),
          (fd.get('attendance_required') === 'true') !== Boolean(employee?.attendance_required)
        ].some(Boolean);

        if (isNew) {
          const insertPayload = { ...common, status:'pending_setup', compensation_type:fd.get('compensation_type'), basic_salary:num(fd.get('basic_salary')), payroll_currency:fd.get('payroll_currency'), default_commission_rate:num(fd.get('default_commission_rate')), attendance_required:fd.get('attendance_required') === 'true', current_shift_id:null };
          const { data, error } = await client.from('employees').insert(insertPayload).select('id').single();
          if (error) throw error;
          employeeId = data.id;
        } else {
          const profile = { ...common };
          delete profile.status;
          const { error } = await client.from('employees').update(profile).eq('id',employee.id).eq('organization_id',orgId());
          if (error) throw error;
          employeeId = employee.id;
        }

        if (selectedShift && (isNew || selectedShift !== employee?.current_shift_id)) {
          const { error } = await client.rpc('assign_employee_shift',{ p_employee_id:employeeId,p_shift_id:selectedShift,p_effective_from:fd.get('shift_effective_from'),p_reason:'Assigned through Adscope HRMS' });
          if (error) throw error;
        }

        if (compensationChanged) {
          const { error } = await client.rpc('set_employee_compensation',{ p_employee_id:employeeId,p_compensation_type:fd.get('compensation_type'),p_basic_salary:num(fd.get('basic_salary')),p_currency:fd.get('payroll_currency'),p_default_commission_rate:num(fd.get('default_commission_rate')),p_attendance_required:fd.get('attendance_required') === 'true',p_effective_from:fd.get('comp_effective_from'),p_reason:'Updated through Adscope HRMS' });
          if (error) throw error;
        }

        const { error:statusError } = await client.from('employees').update({ status:common.status }).eq('id',employeeId).eq('organization_id',orgId());
        if (statusError) throw statusError;
`

const INITIALIZATION_RECOVERY_PATCH = String.raw`<script data-adscope-init-recovery="auth-deadlock-v1">
(function(){
  'use strict';

  var timeoutMs=15000;
  var settled=false;
  var watchdog;
  var observer;
  var initializationRoot=null;

  function initializationPending(){
    return !settled;
  }

  function initializationRendered(){
    return Boolean(initializationRoot&&initializationRoot.querySelector('.login-page,.shell,.page'));
  }

  function markInitializationComplete(){
    if(settled||!initializationRendered())return;
    settled=true;
    if(watchdog)window.clearTimeout(watchdog);
    if(observer)observer.disconnect();
  }

  function observeInitializationRoot(){
    if(settled)return;
    initializationRoot=document.getElementById('app')||document.getElementById('portalApp');
    if(!initializationRoot||typeof MutationObserver!=='function')return;
    observer=new MutationObserver(markInitializationComplete);
    observer.observe(initializationRoot,{childList:true,subtree:true});
    markInitializationComplete();
  }

  function showInitializationError(){
    var root=document.getElementById('app')||document.getElementById('portalApp');
    if(!root)return;
    settled=true;
    if(watchdog)window.clearTimeout(watchdog);
    if(observer)observer.disconnect();
    root.innerHTML='<section class="login-page"><div class="login-card" role="alert"><h1>Unable to open the portal</h1><p>We could not finish preparing your secure workspace. Check your connection and try again.</p><button class="primary full" data-init-retry type="button">Retry</button></div></section>';
    var retry=root.querySelector('[data-init-retry]');
    if(retry)retry.addEventListener('click',function(){location.reload();});
  }

  var supabaseApi=window.supabase;
  if(supabaseApi&&typeof supabaseApi.createClient==='function'){
    var createClient=supabaseApi.createClient;
    supabaseApi.createClient=function(){
      var client=createClient.apply(this,arguments);
      var auth=client&&client.auth;
      if(auth&&typeof auth.onAuthStateChange==='function'&&!auth.__adscopeDeferredAuthCallback){
        var onAuthStateChange=auth.onAuthStateChange.bind(auth);
        auth.onAuthStateChange=function(callback){
          return onAuthStateChange(function(event,session){
            window.setTimeout(function(){
              Promise.resolve()
                .then(function(){return callback(event,session);})
                .catch(function(){if(initializationPending())showInitializationError();});
            },0);
          });
        };
        Object.defineProperty(auth,'__adscopeDeferredAuthCallback',{value:true});
      }
      return client;
    };
  }

  observeInitializationRoot();
  if(!initializationRoot)document.addEventListener('DOMContentLoaded',observeInitializationRoot,{once:true});

  watchdog=window.setTimeout(function(){
    if(initializationPending())showInitializationError();
  },timeoutMs);

})();
</script>`

const UX_PATCH = String.raw`<script data-adscope-ux-patch="english-errors-v2">
(function(){
  'use strict';

  function friendlyMessage(raw){
    var text=String(raw||'').trim();
    if(!text)return 'Something went wrong. Please review the form and try again.';
    var rules=[
      [/employees_(check1|active_payroll_and_shift_check)/i,'Employee could not be saved. An active employee must have a payroll currency and either a base salary greater than 0 or Commission-only compensation. When attendance is required, an assigned shift is also mandatory.'],
      [/duplicate key value.*employee_code|employees_organization_id_employee_code_key/i,'This employee code is already in use. Enter a different employee code.'],
      [/duplicate key value/i,'A record with the same unique information already exists. Review the employee code and email.'],
      [/violates foreign key constraint/i,'One of the selected records is no longer available. Refresh the page and select it again.'],
      [/null value in column/i,'A required field is missing. Review the form and try again.'],
      [/violates check constraint/i,'The entered information does not meet one or more employee rules. Review the salary, compensation type, attendance requirement and assigned shift.'],
      [/invalid input syntax/i,'One of the entered values has an invalid format. Review the form and try again.'],
      [/permission denied|row-level security|new row violates row-level security/i,'You do not have permission to perform this action.'],
      [/jwt.*expired|token.*expired|session.*expired/i,'Your session has expired. Sign in again, then repeat the action.'],
      [/one-time token not found|email link is invalid or has expired|email link has expired/i,'This invitation or password-reset link has expired. Request a new link.'],
      [/failed to fetch|networkerror|load failed|network request failed/i,'The connection was interrupted and the change was not saved. Check your internet connection and try again.'],
      [/more than one relationship was found/i,'The system found an unclear data connection. Refresh the page and try again.'],
      [/something went wrong/i,'Something went wrong. Please review the information and try again.']
    ];
    for(var i=0;i<rules.length;i++)if(rules[i][0].test(text))return rules[i][1];
    return text.replace(/_/g,' ').replace(/\bapp private\b/gi,'the secured HR service').replace(/\bRPC\b/g,'system action');
  }

  function showEnglishError(message,field){
    var root=document.getElementById('toastRoot')||document.body;
    var node=document.createElement('div');
    node.className='toast error';
    node.setAttribute('role','alert');
    node.setAttribute('data-friendly','1');
    node.textContent=message;
    if(root===document.body){
      node.style.cssText='position:fixed;left:16px;right:16px;bottom:18px;z-index:2147483647;padding:14px 16px;border:1px solid #b94a55;border-radius:12px;background:#23151b;color:#fff;font:14px/1.45 Arial,sans-serif;box-shadow:0 14px 40px #0008';
    }
    root.appendChild(node);
    if(field){field.style.borderColor='#d85b5b';field.focus({preventScroll:false});}
    window.setTimeout(function(){node.remove();},8000);
  }

  function reenableVisibleSubmitButtons(form){
    if(!form||!form.querySelectorAll)return;
    form.querySelectorAll('button[type="submit"][disabled]').forEach(function(button){
      button.disabled=false;
      button.removeAttribute('aria-busy');
    });
  }

  function normalizeNode(node){
    if(!(node instanceof Element))return;
    var candidates=[];
    if(node.matches('.toast.error,.notice.error,[role="alert"]'))candidates.push(node);
    node.querySelectorAll('.toast.error,.notice.error,[role="alert"]').forEach(function(item){candidates.push(item);});
    candidates.forEach(function(item){
      if(item.getAttribute('data-friendly')==='1')return;
      var original=item.textContent||'';
      var friendly=friendlyMessage(original);
      if(friendly!==original){
        item.textContent=friendly;
        item.setAttribute('data-friendly','1');
      }
    });
  }

  document.addEventListener('submit',function(event){
    var form=event.target;
    if(!(form instanceof HTMLFormElement))return;
    if(!form.elements.namedItem('employee_code')||!form.elements.namedItem('full_name')||!form.elements.namedItem('status'))return;

    var status=String(form.elements.namedItem('status').value||'');
    if(status!=='active')return;

    var currency=form.elements.namedItem('payroll_currency');
    var compensation=form.elements.namedItem('compensation_type');
    var salary=form.elements.namedItem('basic_salary');
    var attendance=form.elements.namedItem('attendance_required');
    var shift=form.elements.namedItem('current_shift_id');

    var problems=[];
    var firstField=null;

    if(currency&&!String(currency.value||'').trim()){
      problems.push('Select a payroll currency.');
      firstField=firstField||currency;
    }

    var compensationValue=compensation?String(compensation.value||''):'unknown';
    var salaryValue=salary?Number(salary.value||0):null;
    if(compensation&&compensationValue!=='commission_only'&&salary&&salaryValue<=0){
      problems.push('Enter a monthly base salary greater than 0, or change Compensation type to Commission only.');
      firstField=firstField||salary;
    }

    var attendanceRequired=false;
    if(attendance){
      attendanceRequired=attendance.type==='checkbox'
        ?Boolean(attendance.checked)
        :['true','required','yes','1','on'].indexOf(String(attendance.value||'').toLowerCase())>=0;
    }
    if(attendanceRequired&&shift&&!String(shift.value||'').trim()){
      problems.push('Assign a work shift because attendance is marked as Required.');
      firstField=firstField||shift;
    }

    if(problems.length){
      event.preventDefault();
      event.stopImmediatePropagation();
      showEnglishError(problems.join(' '),firstField);
      reenableVisibleSubmitButtons(form);
    }
  },true);

  var uxObserver=new MutationObserver(function(mutations){
    mutations.forEach(function(mutation){mutation.addedNodes.forEach(function(node){normalizeNode(node);});});
  });
  var observedRoots=[document.getElementById('toastRoot'),document.getElementById('app'),document.getElementById('portalApp')].filter(Boolean);
  observedRoots.forEach(function(root){uxObserver.observe(root,{subtree:true,childList:true});});

  document.querySelectorAll('.toast.error,.notice.error,[role="alert"]').forEach(normalizeNode);
  window.ADSCOPE_FRIENDLY_ERROR=friendlyMessage;
})();
</script>`

function injectUxPatch(html: string) {
  if (html.includes('data-adscope-ux-patch="english-errors-v2"')) return html
  if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${UX_PATCH}</body>`)
  return `${html}${UX_PATCH}`
}

function fixEmployeeSaveOrder(html: string, bundle: string) {
  if (bundle !== 'admin' || html.includes(EMPLOYEE_SAVE_ORDER_MARKER)) return html

  const start = '      let employeeId;\n      try {\n'
  const end = "        if (isNew && fd.get('send_invite') === 'true') {"
  const startIndex = html.indexOf(start)
  const endIndex = html.indexOf(end, startIndex)
  if (startIndex < 0 || endIndex < 0) throw new Error('Employee save flow could not be updated')

  let patched = `${html.slice(0, startIndex)}${EMPLOYEE_SAVE_ORDER_BLOCK}${html.slice(endIndex)}`
  if (/<\/body>/i.test(patched)) patched = patched.replace(/<\/body>/i, `${EMPLOYEE_SAVE_ORDER_MARKER}</body>`)
  else patched += EMPLOYEE_SAVE_ORDER_MARKER
  return patched
}

function updateEmployeePortalUrls(html: string) {
  return html
    .replaceAll('https://attendance.adscope.net/', EMPLOYEE_PORTAL_URL)
    .replaceAll('https://attendance.adscope.net', EMPLOYEE_PORTAL_URL.slice(0, -1))
}

function injectInitializationRecovery(html: string) {
  if (html.includes('data-adscope-init-recovery="auth-deadlock-v1"')) return html
  const supabaseScript = /(<script\s+src=["']https:\/\/cdn\.jsdelivr\.net\/npm\/@supabase\/supabase-js@[^"']+["']><\/script>)/i
  if (supabaseScript.test(html)) return html.replace(supabaseScript, `$1${INITIALIZATION_RECOVERY_PATCH}`)
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${INITIALIZATION_RECOVERY_PATCH}</head>`)
  if (/<body\b/i.test(html)) return html.replace(/<body\b/i, `${INITIALIZATION_RECOVERY_PATCH}<body`)
  return `${INITIALIZATION_RECOVERY_PATCH}${html}`
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (req.method !== 'GET') return new Response('Method not allowed', { status: 405, headers: cors })

  try {
    const bundle = new URL(req.url).searchParams.get('bundle') ?? ''
    if (!['admin', 'attendance'].includes(bundle)) return new Response('Unknown bundle', { status: 404, headers: cors })

    const url = Deno.env.get('SUPABASE_URL') ?? ''
    const key = secretKey()
    if (!url || !key) throw new Error('Static asset service is not configured')

    const db = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    })

    const { data, error } = await db.rpc('get_compiled_frontend_bundle', { p_bundle: bundle }).single()
    if (error) throw error
    if (!data?.payload) throw new Error('Compiled bundle is missing')

    const originalHtml = await gunzipBase64(String(data.payload))
    const saveOrderHtml = fixEmployeeSaveOrder(originalHtml, bundle)
    const patchedHtml = injectUxPatch(injectInitializationRecovery(updateEmployeePortalUrls(saveOrderHtml)))
    if (!patchedHtml.includes('data-adscope-init-recovery="auth-deadlock-v1"')) throw new Error('Initialization recovery patch was not applied')
    if (!patchedHtml.includes('data-adscope-ux-patch="english-errors-v2"')) throw new Error('English UX patch was not applied')
    if (bundle === 'admin' && !patchedHtml.includes(EMPLOYEE_SAVE_ORDER_MARKER)) throw new Error('Employee save ordering patch was not applied')
    if (patchedHtml.includes('https://attendance.adscope.net')) throw new Error('Legacy employee portal URL is still present')
    const payload = await gzipBase64(patchedHtml)

    return new Response(payload, {
      headers: {
        ...cors,
        'Content-Type': 'text/plain; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'Pragma': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': String(new TextEncoder().encode(payload).byteLength),
        'X-HRMS-Patch': 'auth-deadlock-v1,english-errors-v2,employee-save-order-v1',
      },
    })
  } catch (error) {
    console.error(error)
    return Response.json(
      { error: 'Unable to load the HRMS portal' },
      { status: 500, headers: { ...cors, 'Cache-Control': 'no-store' } },
    )
  }
})
