(function(){
  'use strict';
  if(window.__ADSCOPE_ATTENDANCE_SESSION_REVIEW__)return;
  window.__ADSCOPE_ATTENDANCE_SESSION_REVIEW__=true;
  if(!window.supabase||!window.ADSCOPE_CONFIG)return;

  var cfg=window.ADSCOPE_CONFIG;
  var client=window.supabase.createClient(cfg.supabaseUrl,cfg.supabasePublishableKey,{auth:{persistSession:true,autoRefreshToken:true,detectSessionInUrl:false}});
  var role=null;
  var roleLoaded=false;
  var observerTimer=null;

  function esc(value){return String(value==null?'':value).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function timezone(){return cfg.timezone||'Africa/Cairo';}
  function localDateTime(value){
    if(!value)return '';
    var parts=new Intl.DateTimeFormat('en-CA',{timeZone:timezone(),year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(value));
    var map={};parts.forEach(function(p){map[p.type]=p.value;});
    return map.year+'-'+map.month+'-'+map.day+'T'+map.hour+':'+map.minute;
  }
  function displayTime(value){return value?new Intl.DateTimeFormat('en-GB',{timeZone:timezone(),dateStyle:'medium',timeStyle:'short'}).format(new Date(value)):'—';}
  function options(values,selected,labels){labels=labels||{};return values.map(function(v){return '<option value="'+esc(v)+'" '+(String(v)===String(selected)?'selected':'')+'>'+esc(labels[v]||String(v).replaceAll('_',' '))+'</option>';}).join('');}
  function toast(message,type){
    var root=document.getElementById('toastRoot')||document.body;
    var node=document.createElement('div');node.className='toast '+(type||'');node.textContent=message;root.appendChild(node);window.setTimeout(function(){node.remove();},5000);
  }
  function errorMessage(error){
    var raw=String(error&&error.message||error||'The attendance review could not be saved.');
    if(/Only an Owner/i.test(raw))return 'Only an Owner can finalize attendance corrections.';
    if(/Final check-out must be later/i.test(raw))return raw;
    if(/Enter the final check-in/i.test(raw))return raw;
    if(/permission denied|row-level security/i.test(raw))return 'You do not have permission to finalize this attendance record.';
    return raw.replaceAll('_',' ');
  }
  async function loadRole(){
    if(roleLoaded)return role;
    var s=await client.auth.getSession();var user=s.data&&s.data.session&&s.data.session.user;
    if(!user){roleLoaded=true;return null;}
    var r=await client.from('organization_memberships').select('role').eq('user_id',user.id).eq('is_active',true).limit(1).maybeSingle();
    if(r.error)throw r.error;role=r.data&&r.data.role||null;roleLoaded=true;return role;
  }
  function closeModal(){var root=document.getElementById('modalRoot');if(root)root.innerHTML='';}
  function refreshAttendance(){var button=document.querySelector('[data-page="attendance"]');if(button){button.click();}else{location.reload();}}

  async function openReview(dayId){
    try{
      var dayResult=await client.from('attendance_days').select('id,attendance_date,status,status_override,notice_provided,late_approval,overtime_approval,check_in_at,check_out_at,break_minutes,worked_minutes,overtime_minutes,session_state,session_expires_at,requires_owner_review,system_issue,excluded_from_totals,review_reason,manual_finalized,finalized_check_in_at,finalized_check_out_at,finalized_break_minutes,source,employee:employees(full_name,employee_code),shift:shifts(name)').eq('id',dayId).single();
      if(dayResult.error)throw dayResult.error;
      var day=dayResult.data;
      var eventsResult=await client.from('attendance_events').select('event_type,occurred_at,source').eq('attendance_day_id',dayId).order('occurred_at');
      if(eventsResult.error)throw eventsResult.error;
      var events=eventsResult.data||[];
      var systemIssue=Boolean(day.system_issue);
      var initialIn=day.finalized_check_in_at||(systemIssue?'':day.check_in_at)||'';
      var initialOut=day.finalized_check_out_at||(systemIssue?'':day.check_out_at)||'';
      var initialBreak=day.finalized_break_minutes!=null?day.finalized_break_minutes:(systemIssue?0:(day.break_minutes||0));
      var root=document.getElementById('modalRoot');if(!root)throw new Error('Attendance review window is unavailable. Refresh the dashboard.');
      var issue=day.requires_owner_review||systemIssue?'<div class="wide notice warning"><strong>'+(systemIssue?'System attendance issue':'Attendance correction required')+'</strong><p>'+esc(day.review_reason||'This record must be finalized by an Owner before it can affect attendance totals or payroll.')+'</p><p><strong>Payroll protection:</strong> '+(day.excluded_from_totals?'This record is currently excluded from worked hours, overtime and monthly balance.':'This record is currently included in totals.')+'</p></div>':'';
      var rawEvents=events.length?events.map(function(event){return '<div style="display:flex;justify-content:space-between;gap:16px;padding:7px 0;border-bottom:1px solid #29435e"><span>'+esc(String(event.event_type).replaceAll('_',' '))+'</span><strong>'+esc(displayTime(event.occurred_at))+'</strong></div>';}).join(''):'<p class="muted">No raw employee events were recorded for this date.</p>';
      root.innerHTML='<div class="modal-backdrop"><section class="modal"><header class="modal-head"><h2>Review attendance</h2><button class="close" data-close>×</button></header><div class="modal-body"><form id="sessionReviewForm"><div class="form-grid">'+
        '<div class="wide notice"><strong>'+esc(day.employee&&day.employee.full_name||'Employee')+' — '+esc(day.attendance_date)+'</strong><p>'+esc(day.shift&&day.shift.name||'No shift')+' · Session: '+esc(day.session_state||'unknown')+'</p></div>'+issue+
        '<div class="wide"><h3 style="margin:0 0 8px">Raw recorded events</h3><p class="muted">These are preserved as evidence and are never rewritten by a correction.</p>'+rawEvents+'</div>'+ 
        '<label class="field"><span>Final check-in ('+esc(timezone())+')</span><input name="check_in" type="datetime-local" value="'+esc(localDateTime(initialIn))+'"></label>'+ 
        '<label class="field"><span>Final check-out ('+esc(timezone())+')</span><input name="check_out" type="datetime-local" value="'+esc(localDateTime(initialOut))+'"></label>'+ 
        '<label class="field"><span>Final break minutes</span><input name="break_minutes" type="number" min="0" step="1" value="'+esc(initialBreak)+'"></label>'+ 
        '<label class="field"><span>Status override</span><select name="status_override"><option value="">Automatic from final times</option>'+options(['present','late','absent','leave','permission','missing_checkout','holiday','weekend','invalid'],day.status_override)+'</select></label>'+ 
        '<label class="field"><span>Notice provided</span><select name="notice_provided">'+options(['true','false'],String(day.notice_provided),{'true':'Yes','false':'No'})+'</select></label>'+ 
        '<label class="field"><span>Late approval</span><select name="late_approval">'+options(['none','pending','approved','rejected'],day.late_approval)+'</select></label>'+ 
        '<label class="field"><span>Overtime approval</span><select name="overtime_approval">'+options(['none','pending','approved','rejected'],day.overtime_approval)+'</select></label>'+ 
        '<label class="field wide"><span>Owner review notes</span><textarea name="notes" rows="3" placeholder="Explain the confirmed correction or review decision"></textarea></label>'+ 
        '<div class="wide notice"><strong>Finalization rule</strong><p>Finalize only after the actual times are confirmed. Final values become attendance-authoritative, but the raw employee events remain in the Audit Log and event history.</p></div>'+ 
        '<div class="wide button-row"><button class="primary" type="submit" data-review-action="finalize">Finalize corrected attendance</button><button class="secondary" type="submit" data-review-action="save">Save review only</button><button class="ghost" type="button" data-cancel>Cancel</button></div>'+ 
        '</div></form></div></section></div>';
      root.querySelector('[data-close]').onclick=closeModal;root.querySelector('[data-cancel]').onclick=closeModal;
      root.querySelector('.modal-backdrop').addEventListener('click',function(e){if(e.target.classList.contains('modal-backdrop'))closeModal();});
      var mode='save';root.querySelectorAll('[data-review-action]').forEach(function(button){button.addEventListener('click',function(){mode=button.dataset.reviewAction;});});
      root.querySelector('#sessionReviewForm').onsubmit=async function(event){
        event.preventDefault();var form=event.currentTarget;var submit=form.querySelector('[data-review-action="'+mode+'"]');if(submit){submit.disabled=true;submit.textContent=mode==='finalize'?'Finalizing…':'Saving…';}
        var fd=new FormData(form);var status=fd.get('status_override')||null;var checkIn=fd.get('check_in')||null;var checkOut=fd.get('check_out')||null;
        var args={p_day_id:day.id,p_status_override:status,p_notice_provided:fd.get('notice_provided')==='true',p_late_approval:fd.get('late_approval'),p_overtime_approval:fd.get('overtime_approval'),p_check_in_local:checkIn,p_check_out_local:checkOut,p_break_minutes:Number(fd.get('break_minutes')||0),p_finalize_review:mode==='finalize',p_notes:fd.get('notes')||null};
        var result=await client.rpc('review_attendance_day',args);
        if(result.error){if(submit){submit.disabled=false;submit.textContent=mode==='finalize'?'Finalize corrected attendance':'Save review only';}return toast(errorMessage(result.error),'error');}
        closeModal();toast(mode==='finalize'?'Attendance correction finalized. Raw events were preserved.':'Attendance review saved.','success');window.setTimeout(refreshAttendance,250);
      };
    }catch(error){toast(errorMessage(error),'error');}
  }

  function install(){
    if(role!=='owner')return;
    var heading=document.querySelector('.topbar h1');if(!heading||heading.textContent.trim()!=='Attendance')return;
    document.querySelectorAll('[data-edit-att]').forEach(function(button){
      if(button.dataset.sessionReview==='1')return;
      button.dataset.sessionReview='1';
      button.onclick=function(event){event.preventDefault();event.stopPropagation();openReview(button.dataset.editAtt);};
      button.textContent='Review / Correct';
    });
  }
  function inspect(){loadRole().then(install).catch(function(){});}
  var observer=new MutationObserver(function(){window.clearTimeout(observerTimer);observerTimer=window.setTimeout(inspect,30);});
  observer.observe(document.documentElement,{childList:true,subtree:true});
  window.setTimeout(inspect,0);
})();
