import { createClient, type User } from 'npm:@supabase/supabase-js@2.106.2'

const ADMIN_ORIGIN = 'https://hrms.adscope.net'
const EMPLOYEE_ORIGIN = 'https://portal.adscope.net'
const LEGACY_EMPLOYEE_ORIGIN = 'https://attendance.adscope.net'
const EXTRA_ALLOWED_ORIGINS = (Deno.env.get('ADMIN_ACCESS_EXTRA_ORIGINS')??'').split(',').map(value=>value.trim()).filter(Boolean)
const ROLES = ['owner','hr_admin','payroll_manager','manager','employee','viewer'] as const
type Role = typeof ROLES[number]
type Membership = { id:string; organization_id:string; user_id:string; role:Role; is_active:boolean }
type Employee = { id:string; organization_id:string; user_id:string|null; employee_code:string; full_name:string; email:string|null; position_title:string|null; status:string; employment_type:string; attendance_required:boolean; portal_enabled:boolean }

function originAllowed(origin:string){ return !origin || origin===ADMIN_ORIGIN || origin===EMPLOYEE_ORIGIN || origin===LEGACY_EMPLOYEE_ORIGIN || EXTRA_ALLOWED_ORIGINS.includes(origin) }
function headers(req:Request){ const origin=req.headers.get('Origin')??''; return {'Access-Control-Allow-Origin':originAllowed(origin)&&origin?origin:ADMIN_ORIGIN,'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type','Access-Control-Allow-Methods':'POST, OPTIONS','Vary':'Origin'} }
function reply(req:Request,body:unknown,status=200){ return Response.json(body,{status,headers:headers(req)}) }
function emailOf(v:unknown){ return String(v??'').trim().toLowerCase() }
function validEmail(v:string){ if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) throw new Error('Enter a valid employee email address.') }
function publicError(error:unknown){
  const raw=error instanceof Error?error.message:String(error??'')
  if(/jwt|session.*expired|invalid.*session/i.test(raw))return 'Your session is invalid or has expired. Sign in again.'
  if(/permission denied|row-level security|not authorized/i.test(raw))return 'You do not have permission to perform this action.'
  if(/duplicate key|constraint|schema|relation|column|invalid input syntax|PGRST|SQL|stack|payload/i.test(raw))return 'The request could not be completed. Review the information and try again.'
  if(!raw||raw.length>300||/[{}\[\]]/.test(raw))return 'The request could not be completed. Try again.'
  return raw
}
function uuid(v:unknown,label:string){ const s=String(v??''); if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s)) throw new Error(`${label} is invalid.`); return s }
function roleOf(v:unknown):Role{ const r=String(v??'') as Role; if(!ROLES.includes(r)) throw new Error('Select a valid HRMS role.'); return r }
function destination(role:Role){ return role==='employee'?`${EMPLOYEE_ORIGIN}/`:`${ADMIN_ORIGIN}/admin/` }
function secretKey(){
  const direct=Deno.env.get('SUPABASE_SECRET_KEY')||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'); if(direct)return direct
  const named=Deno.env.get('SUPABASE_SECRET_KEYS'); if(named){ try{ const parsed=JSON.parse(named); const value=parsed.default??Object.values(parsed)[0]; if(typeof value==='string')return value }catch{} }
  return ''
}
async function allUsers(admin:ReturnType<typeof createClient>){ const out:User[]=[]; for(let page=1;page<=10;page++){ const {data,error}=await admin.auth.admin.listUsers({page,perPage:1000}); if(error)throw error; out.push(...(data.users??[])); if((data.users??[]).length<1000)break } return out }
async function actorContext(admin:ReturnType<typeof createClient>,jwt:string){
  const {data,error}=await admin.auth.getUser(jwt); if(error||!data.user)throw new Error('Your session is invalid or has expired.')
  const {data:m,error:me}=await admin.from('organization_memberships').select('id,organization_id,user_id,role,is_active').eq('user_id',data.user.id).eq('is_active',true).maybeSingle(); if(me)throw me
  if(!m||m.role!=='owner')throw new Error('Only an Owner can manage employee accounts and access.')
  return {user:data.user,membership:m as Membership}
}
async function audit(admin:ReturnType<typeof createClient>,actor:Membership,userId:string,action:string,entityId:string,values:Record<string,unknown>,req:Request){
  const {error}=await admin.from('audit_logs').insert({organization_id:actor.organization_id,actor_user_id:userId,actor_role:actor.role,action,entity_type:'user_access',entity_id:entityId,new_values:values,reason:'User access managed through the HRMS admin portal',user_agent:(req.headers.get('user-agent')??'').slice(0,500)||null}); if(error)console.error(error.message)
}
async function findByEmail(admin:ReturnType<typeof createClient>,email:string){ return (await allUsers(admin)).find(u=>emailOf(u.email)===email) }
async function loadEmployee(admin:ReturnType<typeof createClient>,actor:Membership,id:string){ const {data,error}=await admin.from('employees').select('id,organization_id,user_id,employee_code,full_name,email,position_title,status,employment_type,attendance_required,portal_enabled').eq('id',id).eq('organization_id',actor.organization_id).single(); if(error||!data)throw new Error('Employee record not found.'); return data as Employee }
async function link(admin:ReturnType<typeof createClient>,actor:Membership,employee:Employee,user:User,role:Role,email:string){
  const {error:m}=await admin.from('organization_memberships').upsert({organization_id:actor.organization_id,user_id:user.id,role,is_active:true},{onConflict:'organization_id,user_id'}); if(m)throw m
  const {error:e}=await admin.from('employees').update({user_id:user.id,email,portal_enabled:true}).eq('id',employee.id).eq('organization_id',actor.organization_id); if(e)throw e
}
async function invite(admin:ReturnType<typeof createClient>,employee:Employee,role:Role,email:string){
  const {data,error}=await admin.auth.admin.inviteUserByEmail(email,{redirectTo:destination(role),data:{full_name:employee.full_name,employee_code:employee.employee_code,hrms_destination:role==='employee'?'employee':'admin',hrms_invited_at:new Date().toISOString()}}); if(error)throw error; if(!data.user)throw new Error('The invitation account could not be created.'); return data.user
}
function accessStatus(user:User|undefined,m:Membership|undefined){ if(!user)return'not_invited'; if(!m)return user.email_confirmed_at?'no_role':'invitation_pending'; if(!m.is_active||user.banned_until&&new Date(user.banned_until)>new Date())return'disabled'; if(!user.email_confirmed_at)return'invitation_pending'; return'active' }

Deno.serve(async(req:Request)=>{
  if(req.method==='OPTIONS')return new Response('ok',{headers:headers(req)})
  if(req.method!=='POST')return reply(req,{error:'Method not allowed.'},405)
  const origin=req.headers.get('Origin')??''; if(!originAllowed(origin))return reply(req,{error:'Origin not allowed.'},403)
  try{
    const auth=req.headers.get('Authorization'); if(!auth?.startsWith('Bearer '))throw new Error('Authenticated session required.')
    const url=Deno.env.get('SUPABASE_URL')??''; const key=secretKey(); if(!url||!key)throw new Error('The secure user-management service is not configured.')
    const admin=createClient(url,key,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}})
    const {user:actorUser,membership:actor}=await actorContext(admin,auth.slice(7))
    const body=await req.json().catch(()=>({})) as Record<string,unknown>; const action=String(body.action??'list')

    if(action==='list'){
      const [{data:employees,error:ee},{data:memberships,error:me},users]=await Promise.all([
        admin.from('employees').select('id,organization_id,user_id,employee_code,full_name,email,position_title,status,employment_type,attendance_required,portal_enabled').eq('organization_id',actor.organization_id).order('employee_code'),
        admin.from('organization_memberships').select('id,organization_id,user_id,role,is_active').eq('organization_id',actor.organization_id),allUsers(admin)])
      if(ee)throw ee; if(me)throw me
      const ms=(memberships??[]) as Membership[]; const byId=new Map(users.map(u=>[u.id,u])); const byEmail=new Map(users.filter(u=>u.email).map(u=>[emailOf(u.email),u])); const mbu=new Map(ms.map(m=>[m.user_id,m]))
      const rows=((employees??[]) as Employee[]).map(e=>{ const emailUser=byEmail.get(emailOf(e.email)); const u=e.user_id?byId.get(e.user_id):emailUser&&mbu.has(emailUser.id)?emailUser:undefined; const m=u?mbu.get(u.id):undefined; return {employee_id:e.id,employee_code:e.employee_code,full_name:e.full_name,email:e.email,position_title:e.position_title,employee_status:e.status,employment_type:e.employment_type,attendance_required:e.attendance_required,portal_enabled:e.portal_enabled,user_id:u?.id??null,role:m?.role??null,membership_active:m?.is_active??false,access_status:accessStatus(u,m),invited_at:u?.invited_at??null,email_confirmed_at:u?.email_confirmed_at??null,last_sign_in_at:u?.last_sign_in_at??null,is_current_user:u?.id===actorUser.id} })
      const linked=new Set(rows.map(r=>r.user_id).filter(Boolean)); const standalone=ms.filter(m=>!linked.has(m.user_id)).map(m=>{const u=byId.get(m.user_id);return{employee_id:null,employee_code:null,full_name:String(u?.user_metadata?.full_name??u?.email??'Administrative account'),email:u?.email??null,position_title:'Administrative account',employee_status:null,employment_type:null,attendance_required:false,portal_enabled:false,user_id:m.user_id,role:m.role,membership_active:m.is_active,access_status:accessStatus(u,m),invited_at:u?.invited_at??null,email_confirmed_at:u?.email_confirmed_at??null,last_sign_in_at:u?.last_sign_in_at??null,is_current_user:m.user_id===actorUser.id}})
      return reply(req,{rows:[...standalone,...rows],assignable_roles:[...ROLES],actor_role:actor.role})
    }

    if(action==='invite'){
      const employee=await loadEmployee(admin,actor,uuid(body.employee_id,'Employee')); const role=roleOf(body.role); const email=emailOf(body.email); validEmail(email)
      let user=await findByEmail(admin,email)
      if(user&&employee.user_id&&employee.user_id!==user.id)throw new Error('This email belongs to a different login account.')
      if(user){ const {data:linkedEmployees,error}=await admin.from('employees').select('id,organization_id,full_name').eq('user_id',user.id); if(error)throw error; const crossTenant=(linkedEmployees??[]).find(item=>item.organization_id!==actor.organization_id); if(crossTenant)throw new Error('This email is already linked to another organization.'); const other=(linkedEmployees??[]).find(item=>item.organization_id===actor.organization_id&&item.id!==employee.id); if(other)throw new Error(`This login is already linked to ${other.full_name}.`) }
      let existingMemberships:Membership[]=[]
      if(user){ const {data,error}=await admin.from('organization_memberships').select('id,organization_id,user_id,role,is_active').eq('user_id',user.id); if(error)throw error; existingMemberships=(data??[]) as Membership[]; if(existingMemberships.some(m=>m.organization_id!==actor.organization_id))throw new Error('This email is already linked to another organization.') }
      let type='invitation'
      if(user?.email_confirmed_at){ await link(admin,actor,employee,user,role,email); const {error}=await admin.auth.resetPasswordForEmail(email,{redirectTo:destination(role)}); if(error)throw error; type='password_reset' }
      else{ if(user){ if(employee.user_id!==user.id&&!existingMemberships.some(m=>m.organization_id===actor.organization_id))throw new Error('An unconfirmed account already exists for this email. Contact an Owner to verify it before reinviting.'); const {error}=await admin.auth.admin.deleteUser(user.id); if(error)throw error; const {error:clearError}=await admin.from('employees').update({user_id:null,portal_enabled:false}).eq('id',employee.id).eq('organization_id',actor.organization_id); if(clearError)throw clearError } user=await invite(admin,employee,role,email); await link(admin,actor,employee,user,role,email) }
      await audit(admin,actor,actorUser.id,'INVITE_USER',user.id,{employee_id:employee.id,email,role,email_type:type},req)
      return reply(req,{ok:true,message:type==='invitation'?`Invitation sent to ${email}.`:`Access activated and a password setup email was sent to ${email}.`})
    }

    if(action==='update_access'){
      const userId=uuid(body.user_id,'User'); const role=roleOf(body.role); const active=body.is_active!==false
      const {data:m,error}=await admin.from('organization_memberships').select('id,organization_id,user_id,role,is_active').eq('organization_id',actor.organization_id).eq('user_id',userId).single(); if(error||!m)throw new Error('User access record not found.')
      if(userId===actorUser.id&&(!active||role!==m.role))throw new Error('You cannot change or deactivate your own Owner access.')
      if(m.role==='owner'&&!active){ const {count}=await admin.from('organization_memberships').select('id',{count:'exact',head:true}).eq('organization_id',actor.organization_id).eq('role','owner').eq('is_active',true); if((count??0)<=1)throw new Error('The company must keep at least one active Owner.') }
      const {error:mu}=await admin.from('organization_memberships').update({role,is_active:active}).eq('id',m.id); if(mu)throw mu
      const {error:au}=await admin.auth.admin.updateUserById(userId,{ban_duration:active?'none':'876000h'}); if(au)throw au
      const {error:eu}=await admin.from('employees').update({portal_enabled:active}).eq('organization_id',actor.organization_id).eq('user_id',userId); if(eu)throw eu
      await audit(admin,actor,actorUser.id,active?'UPDATE_USER_ACCESS':'SUSPEND_USER_ACCESS',userId,{role,is_active:active},req)
      return reply(req,{ok:true,message:active?'User access updated and activated.':'User account suspended.'})
    }

    if(action==='send_access_email'){
      const userId=uuid(body.user_id,'User'); const {data:m,error:membershipError}=await admin.from('organization_memberships').select('role').eq('organization_id',actor.organization_id).eq('user_id',userId).maybeSingle(); if(membershipError)throw membershipError; if(!m)throw new Error('This login does not belong to your organization.')
      const {data:u,error}=await admin.auth.admin.getUserById(userId); if(error||!u.user?.email)throw new Error('Login account not found.'); const role=m.role as Role
      const {error:reset}=await admin.auth.resetPasswordForEmail(u.user.email,{redirectTo:destination(role)}); if(reset)throw reset
      await audit(admin,actor,actorUser.id,'SEND_PASSWORD_RESET',userId,{email:u.user.email},req); return reply(req,{ok:true,message:`Password setup/reset email sent to ${u.user.email}.`})
    }

    if(action==='delete_test'){
      const userId=uuid(body.user_id,'User'); if(userId===actorUser.id)throw new Error('You cannot delete your own account.')
      const {data:m,error:membershipError}=await admin.from('organization_memberships').select('role').eq('organization_id',actor.organization_id).eq('user_id',userId).maybeSingle(); if(membershipError)throw membershipError; if(!m)throw new Error('This login does not belong to your organization.'); if(m.role==='owner')throw new Error('Owner accounts cannot be deleted from this action.')
      const {data:e,error:employeeError}=await admin.from('employees').select('id,full_name').eq('organization_id',actor.organization_id).eq('user_id',userId).maybeSingle(); if(employeeError)throw employeeError
      if(e){ const checks=await Promise.all([
        admin.from('attendance_days').select('id',{count:'exact',head:true}).eq('employee_id',e.id),
        admin.from('leave_requests').select('id',{count:'exact',head:true}).eq('employee_id',e.id),
        admin.from('advances').select('id',{count:'exact',head:true}).eq('employee_id',e.id),
        admin.from('violations').select('id',{count:'exact',head:true}).eq('employee_id',e.id),
        admin.from('payroll_items').select('id',{count:'exact',head:true}).eq('employee_id',e.id)])
        if(checks.some(r=>r.error))throw new Error('Unable to verify employee history. Try again before deleting this login.')
        if(checks.some(r=>(r.count??0)>0))throw new Error('This account has HR or payroll history. Suspend it instead of deleting it.')
        const {error:unlink}=await admin.from('employees').update({user_id:null,portal_enabled:false}).eq('id',e.id); if(unlink)throw unlink
      }
      const {error:deleteMembershipError}=await admin.from('organization_memberships').delete().eq('organization_id',actor.organization_id).eq('user_id',userId); if(deleteMembershipError)throw deleteMembershipError
      const {error:del}=await admin.auth.admin.deleteUser(userId); if(del)throw del
      await audit(admin,actor,actorUser.id,'DELETE_TEST_USER',userId,{employee_id:e?.id??null},req); return reply(req,{ok:true,message:'Test login deleted. Employee history was not removed.'})
    }
    throw new Error('Unsupported user-access action.')
  }catch(error){ console.error(error); const message=publicError(error); return reply(req,{error:message},/session|authenticated/i.test(message)?401:/Only an Owner|cannot|must keep|Owner accounts/i.test(message)?403:400) }
})
