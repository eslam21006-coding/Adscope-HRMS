import { createClient } from 'npm:@supabase/supabase-js@2.106.2'

const origins=['https://hrms.adscope.net','https://portal.adscope.net','https://attendance.adscope.net']
const extraOrigins=(Deno.env.get('DISCIPLINARY_EMAIL_EXTRA_ORIGINS')??'').split(',').map(value=>value.trim()).filter(Boolean)
function allowed(origin:string){return !origin||origins.includes(origin)||extraOrigins.includes(origin)}
function h(req:Request){const origin=req.headers.get('Origin')||'';return{'Access-Control-Allow-Origin':allowed(origin)&&origin?origin:origins[0],'Access-Control-Allow-Headers':'authorization, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'}}
function out(req:Request,body:unknown,status=200){return Response.json(body,{status,headers:h(req)})}

class PublicHttpError extends Error{constructor(message:string,readonly status:number){super(message)}}
function publicError(error:unknown){
  if(error instanceof PublicHttpError)return error.message
  const raw=error instanceof Error?error.message:String(error??'')
  if(/sign in|session expired/i.test(raw))return'Your session expired. Sign in again.'
  if(/Only an Owner/i.test(raw))return raw
  return'Unable to send the disciplinary email. Please try again.'
}
function uuid(value:unknown){const id=String(value??'');if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id))throw new PublicHttpError('The disciplinary case is invalid.',400);return id}
async function deterministicAttemptId(value:string){
  const bytes=new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))).slice(0,16)
  bytes[6]=(bytes[6]&0x0f)|0x50;bytes[8]=(bytes[8]&0x3f)|0x80
  const hex=[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('')
  return`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:h(req)})
  if(req.method!=='POST')return out(req,{error:'Method not allowed.'},405)
  try{
    const origin=req.headers.get('Origin')||'';if(!allowed(origin))return out(req,{error:'This request origin is not allowed.'},403)
    const auth=req.headers.get('Authorization');if(!auth)throw new PublicHttpError('Sign in required.',401)
    const url=Deno.env.get('SUPABASE_URL')??'';const publicKey=Deno.env.get('SUPABASE_ANON_KEY')??'';const privateKey=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')??''
    if(!url||!publicKey||!privateKey)throw new Error('Email service is not configured')
    const user=createClient(url,publicKey,{global:{headers:{Authorization:auth}},auth:{persistSession:false}})
    const admin=createClient(url,privateKey,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}})
    const input=await req.json().catch(()=>({})) as Record<string,unknown>;const caseId=uuid(input.violation_id);const action=String(input.action||'send_notice')
    if(!['send_notice','send_final'].includes(action))throw new PublicHttpError('Unsupported disciplinary email action.',400)

    const {data:me,error:meError}=await user.auth.getUser();if(meError||!me.user)throw new PublicHttpError('Session expired.',401)
    const {data:violation,error:violationError}=await admin.from('violations').select('id,organization_id').eq('id',caseId).maybeSingle();if(violationError)throw violationError;if(!violation)throw new PublicHttpError('Disciplinary case not found.',404)
    const {data:membership,error:membershipError}=await admin.from('organization_memberships').select('role').eq('organization_id',violation.organization_id).eq('user_id',me.user.id).eq('is_active',true).eq('role','owner').maybeSingle();if(membershipError)throw membershipError;if(!membership)throw new PublicHttpError('Only an Owner in this organization can send disciplinary emails.',403)

    const emailType=action==='send_notice'?'notice':'final_decision'
    const {data:sentLog,error:sentLogError}=await admin.from('disciplinary_email_logs').select('id,provider_message_id').eq('violation_id',caseId).eq('email_type',emailType).eq('delivery_status','sent').order('created_at',{ascending:false}).limit(1).maybeSingle();if(sentLogError)throw sentLogError
    if(sentLog)return out(req,{ok:true,message:action==='send_notice'?'Disciplinary notice was already sent.':'Final decision email was already sent.',id:sentLog.provider_message_id,already_sent:true})

    const attemptId=await deterministicAttemptId(`${caseId}:${emailType}`)
    const {data:existingAttempt,error:existingAttemptError}=await admin.from('disciplinary_email_logs').select('id,delivery_status').eq('id',attemptId).maybeSingle();if(existingAttemptError)throw existingAttemptError
    if(existingAttempt&&['sending','delivery_unknown'].includes(existingAttempt.delivery_status))throw new PublicHttpError('This email may already be in delivery. An Owner must review its status before retrying.',409)

    const {data:key,error:keyError}=await admin.rpc('get_hrms_email_secret');if(keyError||!key)throw new Error('Email service key unavailable')
    let payload:any
    if(action==='send_notice'){const result=await user.rpc('prepare_disciplinary_notice',{p_violation_id:caseId});if(result.error)throw result.error;payload=result.data}
    else{const result=await admin.rpc('get_disciplinary_final_email_payload',{p_violation_id:caseId});if(result.error)throw result.error;payload=result.data}
    if(!payload?.recipient_email)throw new PublicHttpError('The employee email address is missing.',400)

    const {error:createAttemptError}=await admin.from('disciplinary_email_logs').upsert({id:attemptId,organization_id:violation.organization_id,violation_id:caseId,email_type:emailType,recipient_email:payload.recipient_email,delivery_status:'queued'},{onConflict:'id',ignoreDuplicates:true});if(createAttemptError)throw createAttemptError
    const {data:attempt,error:attemptError}=await admin.from('disciplinary_email_logs').select('id,delivery_status').eq('id',attemptId).single();if(attemptError||!attempt)throw attemptError??new Error('Delivery attempt not found')
    if(['sending','delivery_unknown'].includes(attempt.delivery_status))throw new PublicHttpError('This email may already be in delivery. An Owner must review its status before retrying.',409)
    const {error:markSendingError}=await admin.from('disciplinary_email_logs').update({recipient_email:payload.recipient_email,delivery_status:'sending',error_message:null}).eq('id',attemptId);if(markSendingError)throw markSendingError

    let response:Response
    try{
      response=await fetch('https://api.resend.com/emails',{method:'POST',signal:AbortSignal.timeout(10_000),headers:{Authorization:'Bearer '+key,'Content-Type':'application/json','Idempotency-Key':`disciplinary-email/${attemptId}`},body:JSON.stringify({from:`${payload.sender_name} <${payload.sender_email}>`,to:[payload.recipient_email],subject:payload.subject,text:payload.body,reply_to:[payload.reply_to]})})
    }catch(error){
      const isTimeout=error instanceof DOMException&&error.name==='TimeoutError'
      const {error:markUnknownError}=await admin.from('disciplinary_email_logs').update({delivery_status:'delivery_unknown',error_message:isTimeout?'Email provider timed out before confirming delivery.':'Email provider connection ended before confirming delivery.'}).eq('id',attemptId);if(markUnknownError)console.error(markUnknownError)
      throw new PublicHttpError(isTimeout?'The email provider did not respond in time. Delivery was not retried automatically.':'The email provider connection ended before delivery was confirmed.',isTimeout?504:502)
    }

    const sent=await response.json().catch(()=>({})) as Record<string,unknown>
    if(!response.ok){const message=String(sent.message||'Email delivery failed');const {error:markFailedError}=await admin.from('disciplinary_email_logs').update({delivery_status:'failed',error_message:message.slice(0,1000)}).eq('id',attemptId);if(markFailedError)throw markFailedError;throw new PublicHttpError('The email provider rejected the message. Review the email settings and try again.',502)}
    const providerMessageId=String(sent.id||'')
    if(!providerMessageId){const {error:markUnknownError}=await admin.from('disciplinary_email_logs').update({delivery_status:'delivery_unknown',error_message:'Email provider accepted the request without returning a delivery reference.'}).eq('id',attemptId);if(markUnknownError)console.error(markUnknownError);throw new PublicHttpError('The email provider did not return a delivery reference. Do not retry until an Owner reviews the delivery status.',502)}

    const finalization=action==='send_notice'
      ?await admin.rpc('confirm_disciplinary_notice_sent_service',{p_violation_id:caseId,p_provider_message_id:providerMessageId})
      :await admin.rpc('log_disciplinary_email_service',{p_violation_id:caseId,p_email_type:emailType,p_recipient_email:payload.recipient_email,p_provider_message_id:providerMessageId,p_status:'sent',p_error:null})
    if(finalization.error){const {error:markUnknownError}=await admin.from('disciplinary_email_logs').update({provider_message_id:providerMessageId,delivery_status:'delivery_unknown',error_message:'Provider accepted the email but the HRMS delivery record was not finalized.'}).eq('id',attemptId);if(markUnknownError)console.error(markUnknownError);throw new PublicHttpError('The email was accepted, but its HRMS record could not be finalized. Do not retry until an Owner reviews it.',502)}
    const {error:cleanupError}=await admin.from('disciplinary_email_logs').delete().eq('id',attemptId);if(cleanupError)console.error(cleanupError)
    return out(req,{ok:true,message:action==='send_notice'?'Disciplinary notice sent.':'Final decision email sent.',id:providerMessageId})
  }catch(error){console.error(error);const message=publicError(error);const status=error instanceof PublicHttpError?error.status:/session|sign in/i.test(message)?401:/Only an Owner/i.test(message)?403:400;return out(req,{error:message},status)}
})
