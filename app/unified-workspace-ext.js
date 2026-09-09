const $=(id)=>document.getElementById(id)
const previousTasks=new Map()
let enrichBusy=false

function sid(){const match=/^#\/session\/([^/?]+)/.exec(location.hash||'');return match?decodeURIComponent(match[1]):''}
function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
async function req(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});if(!response.ok){const text=await response.text().catch(()=>'');throw new Error(`${response.status} ${response.statusText}${text?`: ${text.slice(0,240)}`:''}`)}return response.json()}
function toast(text){const el=$('toast');if(!el)return;el.textContent=text;el.hidden=false;clearTimeout(el._workspaceExtTimer);el._workspaceExtTimer=setTimeout(()=>el.hidden=true,3200)}

async function addPermissionRule(rule){
  const sessionID=sid()
  if(!sessionID)return
  const summary=`${rule.effect} ${rule.action} → ${rule.resource}`
  if(!window.confirm(`Добавить project permission rule?\n\n${summary}\n\nR3/R4 server risk floors всё равно останутся обязательными.`))return
  try{
    await req('/client-project-settings.json',{method:'POST',body:JSON.stringify({sessionID,addPermission:rule})})
    toast('Permission rule saved')
    window.CustomOpenCodeWorkspace?.refresh?.()
  }catch(error){toast(`Permission rule: ${error.message}`)}
}

async function githubAction(action,reference){
  const sessionID=sid()
  if(!sessionID||!reference.trim())return
  try{
    const value=await req('/client-github-workflow.json',{method:'POST',body:JSON.stringify({action,sessionID,reference:reference.trim(),profile:'build'})})
    if(action==='issue-task')toast(`GitHub issue task: ${value.task?.id||'created'}`)
    else toast(`PR review tasks: ${value.created||0}`)
    window.CustomOpenCodeWorkspace?.refresh?.()
  }catch(error){toast(`GitHub: ${error.message}`)}
}

async function enrichRuntime(){
  const host=$('unified-runtime'),sessionID=sid()
  if(!host||!sessionID||host.hidden||host.dataset.unavailable==='true'||host.querySelector('[data-unified-ext]')||enrichBusy)return
  enrichBusy=true
  try{
    const [snapshot,github]=await Promise.all([
      req(`/client-unified.json?sessionID=${encodeURIComponent(sessionID)}`),
      req(`/client-github-workflow.json?sessionID=${encodeURIComponent(sessionID)}`).catch(error=>({ok:false,error:error.message,github:{available:false}})),
    ])
    if(!host.isConnected||host.querySelector('[data-unified-ext]'))return
    const advice=snapshot?.project?.permissionAdvice?.suggestions||[]
    const permission=document.createElement('div')
    permission.className='unified-card unified-ext-card'
    permission.dataset.unifiedExt='permission'
    permission.innerHTML=`<h4>Permission Advisor</h4><div class="unified-muted">Повторяющиеся approvals превращаются только в предлагаемые project rules. Ничего не применяется без подтверждения; R3/R4 не понижаются.</div>${advice.slice(0,8).map((item,index)=>`<div class="unified-event"><div class="unified-event-head"><span class="unified-pill">${Number(item.count||0)}×</span><strong>${esc(item.action||'*')}</strong></div><div class="unified-event-data">${esc(item.resource||'*')}</div><div class="unified-actions"><button type="button" data-advice-index="${index}">Add allow rule</button></div></div>`).join('')||'<div class="unified-muted" style="margin-top:8px">Пока нет достаточно повторяющихся approvals.</div>'}`
    permission.querySelectorAll('[data-advice-index]').forEach(button=>button.addEventListener('click',()=>{const item=advice[Number(button.dataset.adviceIndex)];if(item?.proposedRule)addPermissionRule(item.proposedRule)}))
    host.append(permission)

    const info=github?.github||{}
    const git=document.createElement('div')
    git.className='unified-card unified-ext-card'
    git.dataset.unifiedExt='github'
    git.innerHTML=`<h4>GitHub workflow</h4><div class="unified-row"><span>Repository</span><strong>${esc(info.repository||'—')}</strong></div><div class="unified-row"><span>gh CLI</span><strong>${info.available?'ready':info.ghInstalled?(info.authenticated?'repository unavailable':'not authenticated'):'not installed'}</strong></div><div class="unified-search" style="position:static;padding-top:8px"><input id="unifiedGithubReference" placeholder="Issue/PR #, owner/repo#123 or URL"><button id="unifiedGithubIssue" type="button">Issue → task</button></div><div class="unified-actions"><button id="unifiedGithubReview" type="button">Sync PR review → child tasks</button></div><div class="unified-muted">Issue tasks создаются isolated worktree. Review comments дедуплицируются по GitHub comment ID.</div>`
    host.append(git)
    $('unifiedGithubIssue')?.addEventListener('click',()=>githubAction('issue-task',$('unifiedGithubReference')?.value||''))
    $('unifiedGithubReview')?.addEventListener('click',()=>githubAction('sync-pr-review',$('unifiedGithubReference')?.value||''))
  }catch(error){console.debug('unified runtime extension',error)}finally{enrichBusy=false}
}

function observeRuntime(){
  const host=$('unified-runtime')
  if(!host){setTimeout(observeRuntime,250);return}
  const observer=new MutationObserver(()=>queueMicrotask(enrichRuntime))
  observer.observe(host,{childList:true})
  document.addEventListener('click',event=>{if(event.target.closest('[data-unified-tab="runtime"]'))setTimeout(enrichRuntime,60)},true)
  enrichRuntime()
}

async function serviceWorkerNotify(task,sessionID){
  if(!('serviceWorker'in navigator)||!('Notification'in window)||Notification.permission!=='granted')return
  try{
    const registration=await navigator.serviceWorker.ready
    const actions=[]
    if(['failed','needs_attention'].includes(task.state))actions.push({action:'retry-task',title:'Retry'})
    if(['running','submitted','waiting_permission','verifying'].includes(task.state))actions.push({action:'cancel-task',title:'Cancel'})
    actions.push({action:'open',title:'Open'})
    await registration.showNotification('OpenCode task',{
      body:`${task.kind||'task'}: ${task.state}`,
      tag:`runtime-actionable-${task.id}`,
      renotify:true,
      data:{url:`/#/session/${encodeURIComponent(sessionID)}`,taskID:task.id,sessionID},
      actions:actions.slice(0,2),
    })
  }catch(error){console.debug('actionable notification',error)}
}

async function watchTaskTransitions(){
  const sessionID=sid()
  if(!sessionID||document.visibilityState==='visible')return
  try{
    const value=await req(`/client-tasks.json?sessionID=${encodeURIComponent(sessionID)}&limit=200`)
    for(const task of value.tasks||[]){
      const before=previousTasks.get(task.id)
      previousTasks.set(task.id,task.state)
      if(before&&before!==task.state&&['completed','needs_attention','failed','waiting_permission'].includes(task.state))await serviceWorkerNotify(task,sessionID)
    }
  }catch(error){console.debug('remote task watch',error)}
}

function resetWatch(){previousTasks.clear()}
window.addEventListener('hashchange',resetWatch)
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden')watchTaskTransitions()})
setInterval(watchTaskTransitions,7000)
observeRuntime()
