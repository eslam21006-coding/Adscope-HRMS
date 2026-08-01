import { createClient } from 'npm:@supabase/supabase-js@2.106.2'
const origins=['https://hrms.adscope.net','https://portal.adscope.net','https://attendance.adscope.net']
function allowed(o:string){return !o||origins.includes(o)||o.endsWith('.vercel.app')}
function h(req:Request){const o=req.headers.get('Origin')||'';return{'Access-Control-Allow-Origin':allowed(o)&&o?o:origins[0],'Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'}}
function out(req:Request,x:unknown,s=200){return Response.json(x,{status:s,headers:h(req)})}
function publicError(e:unknown){const raw=e instanceof Error?e.message:String(e??'');if(/sign in|session expired/i.test(raw))return'Your session expired. Sign in again.';if(/Only an Owner/i.test(raw))return raw;return'Unable to send the disciplinary email. Please try again.'}
Deno.serve(async(req:Request)=>{
 if(req.method==='OPTIONS')return new Response('ok',{headers:h(req)})
 try{
  const origin=req.headers.get('Origin')||'';if(!allowed(origin))return out(req,{error:'This request origin is not allowed.'},403)
  const auth=req.headers.get('Authorization');if(!auth)throw new Error('Sign in required')
  const url=Deno.env.get('SUPABASE_URL')!;const publicKey=Deno.env.get('SUPABASE_ANON_KEY')!;const privateKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const user=createClient(url,publicKey,{global:{headers:{Authorization:auth}},auth:{persistSession:false}})
  const admin=createClient(url,privateKey,{auth:{persistSession:false}})
  const input=await req.json();const caseId=String(input.violation_id||'')
  const {data:me,error:meError}=await user.auth.getUser();if(meError||!me.user)throw new Error('Session expired')
  const {data:membership}=await user.from('organization_memberships').select('role').eq('user_id',me.user.id).eq('is_active',true).maybeSingle();if(membership?.role!=='owner')throw new Error('Only an Owner can send disciplinary emails')
  const {data:key,error:keyError}=await admin.rpc('get_hrms_email_secret');if(keyError||!key)throw new Error('Email service key unavailable')
  const action=String(input.action||'send_notice')
  let payload:any
  if(action==='send_notice'){const r=await user.rpc('prepare_disciplinary_notice',{p_violation_id:caseId});if(r.error)throw r.error;payload=r.data}
  else if(action==='send_final'){const r=await admin.rpc('get_disciplinary_final_email_payload',{p_violation_id:caseId});if(r.error)throw r.error;payload=r.data}
  else throw new Error('Unsupported action')
  const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({from:`${payload.sender_name} <${payload.sender_email}>`,to:[payload.recipient_email],subject:payload.subject,text:payload.body,reply_to:[payload.reply_to]})})
  const sent=await response.json();if(!response.ok)throw new Error(sent.message||'Email delivery failed')
  if(action==='send_notice'){const c=await admin.rpc('confirm_disciplinary_notice_sent_service',{p_violation_id:caseId,p_provider_message_id:sent.id});if(c.error)throw c.error}
  else await admin.rpc('log_disciplinary_email_service',{p_violation_id:caseId,p_email_type:'final_decision',p_recipient_email:payload.recipient_email,p_provider_message_id:sent.id,p_status:'sent',p_error:null})
  return out(req,{ok:true,message:action==='send_notice'?'Disciplinary notice sent.':'Final decision email sent.',id:sent.id})
 }catch(e){console.error(e);return out(req,{error:publicError(e)},400)}
})
