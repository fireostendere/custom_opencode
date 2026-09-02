const $=(id)=>document.getElementById(id)

const state={
  open:false,
  tab:'activity',
  snapshot:null,
  activity:[],
  plan:null,
  search:[],
  followActivity:true,
  unseen:0,
  lastEventID:0,
  timer:null,
  actions:[],
  selectedCommand:0,
  refreshSeq:0,
  planSeq:0,
}

function esc(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function sid(){const match=/^#\/session\/([^/?]+)/.exec(location.hash||'');return match?decodeURIComponent(match[1]):''}
function qs(path){const session=sid();return `${path}${session?`${path.includes('?')?'&':'?'}sessionID=${encodeURIComponent(session)}`:''}`}
async function req(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});if(!response.ok){const text=await response.text().catch(()=>'');throw new Error(`${response.status} ${response.statusText}${text?`: ${text.slice(0,280)}`:''}`)}if(response.status===204)return null;const type=response.headers.get('content-type')||'';return type.includes('application/json')?response.json():response.text()}
function toast(text){const el=$('toast');if(!el)return;el.textContent=text;el.hidden=false;clearTimeout(el._unifiedTimer);el._unifiedTimer=setTimeout(()=>el.hidden=true,3200)}
function timeLabel(value){if(!value)return'';try{return new Date(Number(value)).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'})}catch{return''}}
function statusClass(ok){return ok===true?'unified-ok':ok===false?'unified-danger':''}

function ensureUI(){
  if(!$('unifiedPanelToggle')){
    const button=document.createElement('button')
    button.id='unifiedPanelToggle'
    button.type='button'
    button.className='header-chip unified-panel-toggle'
    button.textContent='Panel'
    button.title='Universal Panel · Ctrl+K'
    const anchor=$('gitButton')||$('usageButton')
    anchor?.after(button)
    button.addEventListener('click',()=>togglePanel())
  }
  if(!$('unifiedScrim')){
    const scrim=document.createElement('div')
    scrim.id='unifiedScrim';scrim.className='unified-scrim';scrim.hidden=true
    scrim.addEventListener('click',()=>closePanel())
    document.body.append(scrim)
  }
  if(!$('unifiedPanel')){
    const panel=document.createElement('aside')
    panel.id='unifiedPanel';panel.className='unified-panel';panel.setAttribute('aria-label','Universal workspace panel')
    panel.innerHTML=`
      <div class="unified-panel-head"><strong>Workspace</strong><span id="unifiedPanelContext" class="unified-muted"></span><button id="unifiedRefresh" type="button" title="Refresh">↻</button><button id="unifiedClose" type="button" title="Close">×</button></div>
      <div class="unified-tabs" id="unifiedTabs">
        <button class="unified-tab" data-unified-tab="activity">Activity</button>
        <button class="unified-tab" data-unified-tab="plan">Plan</button>
        <button class="unified-tab" data-unified-tab="changes">Changes</button>
        <button class="unified-tab" data-unified-tab="verification">Verify</button>
        <button class="unified-tab" data-unified-tab="runtime">Runtime</button>
        <button class="unified-tab" data-unified-tab="rag">RAG/MCP</button>
        <button class="unified-tab" data-unified-tab="search">Search</button>
      </div>
      <div class="unified-panel-body">
        ${['activity','plan','changes','verification','runtime','rag','search'].map(name=>`<section class="unified-view" id="unified-${name}" data-unified-view="${name}" hidden></section>`).join('')}
      </div>`
    document.body.append(panel)
    $('unifiedClose').addEventListener('click',closePanel)
    $('unifiedRefresh').addEventListener('click',()=>refreshAll(true))
    $('unifiedTabs').addEventListener('click',event=>{const button=event.target.closest('[data-unified-tab]');if(button)setTab(button.dataset.unifiedTab)})
    const activity=$('unified-activity')
    activity.addEventListener('scroll',()=>{
      const distance=activity.scrollHeight-activity.clientHeight-activity.scrollTop
      state.followActivity=distance<72
      if(state.followActivity){state.unseen=0;renderActivityFollow()}
    },{passive:true})
  }
  if(!$('unifiedPalette')){
    const palette=document.createElement('div')
    palette.id='unifiedPalette';palette.className='unified-palette';palette.hidden=true
    palette.innerHTML=`<div class="unified-palette-box"><input id="unifiedPaletteInput" autocomplete="off" placeholder="Action or command…"><div id="unifiedPaletteList" class="unified-palette-list"></div></div>`
    document.body.append(palette)
    palette.addEventListener('click',event=>{if(event.target===palette)closePalette();const command=event.target.closest('[data-unified-command]');if(command)runAction(command.dataset.unifiedCommand)})
    $('unifiedPaletteInput').addEventListener('input',()=>{state.selectedCommand=0;renderPalette()})
    $('unifiedPaletteInput').addEventListener('keydown',event=>{
      const commands=filteredActions()
      if(event.key==='ArrowDown'){event.preventDefault();state.selectedCommand=Math.min(commands.length-1,state.selectedCommand+1);renderPalette()}
      else if(event.key==='ArrowUp'){event.preventDefault();state.selectedCommand=Math.max(0,state.selectedCommand-1);renderPalette()}
      else if(event.key==='Enter'){event.preventDefault();const item=commands[state.selectedCommand];if(item)runAction(item.id)}
      else if(event.key==='Escape'){event.preventDefault();closePalette()}
    })
  }
}

function togglePanel(tab){state.open?closePanel():openPanel(tab)}
function openPanel(tab=state.tab){ensureUI();state.open=true;$('unifiedPanel').classList.add('open');$('unifiedScrim').hidden=false;setTab(tab);refreshAll(true);startPolling()}
function closePanel(){state.open=false;$('unifiedPanel')?.classList.remove('open');if($('unifiedScrim'))$('unifiedScrim').hidden=true;stopPolling()}
function setTab(tab){state.tab=tab||'activity';document.querySelectorAll('[data-unified-tab]').forEach(button=>button.classList.toggle('active',button.dataset.unifiedTab===state.tab));document.querySelectorAll('[data-unified-view]').forEach(view=>view.hidden=view.dataset.unifiedView!==state.tab);renderCurrent()}

function startPolling(){stopPolling();state.timer=setInterval(()=>{if(state.open)refreshAll(false)},2800)}
function stopPolling(){if(state.timer){clearInterval(state.timer);state.timer=null}}

async function refreshAll(force=false){
  const session=sid()
  const refreshSeq=++state.refreshSeq
  $('unifiedPanelContext').textContent=session?session.slice(0,10):'no session'
  if(!session){state.snapshot=null;state.activity=[];renderCurrent();return}
  try{
    const [snapshot,activity]=await Promise.all([
      req(qs('/client-unified.json')),
      req(`${qs('/client-activity.json')}&after=${force?0:state.lastEventID}&limit=300`),
    ])
    if(sid()!==session||state.refreshSeq!==refreshSeq)return
    state.snapshot=snapshot
    state.actions=snapshot.actions||state.actions
    const incoming=activity.events||[]
    if(force){state.activity=incoming;state.lastEventID=Math.max(0,...incoming.map(item=>Number(item.id)||0));state.unseen=0}
    else if(incoming.length){
      const known=new Set(state.activity.map(item=>String(item.id)))
      const fresh=incoming.filter(item=>!known.has(String(item.id)))
      state.activity=[...state.activity,...fresh].slice(-800)
      state.lastEventID=Math.max(state.lastEventID,...fresh.map(item=>Number(item.id)||0))
      if(!state.followActivity)state.unseen+=fresh.length
    }
    if(force||state.tab==='plan')loadPlan().catch(()=>{})
    renderCurrent()
  }catch(error){console.debug('unified workspace refresh',error)}
}

async function loadPlan(){const sessionID=sid(),planSeq=++state.planSeq;try{const value=await req(qs('/client-plan.json'));if(sid()!==sessionID||state.planSeq!==planSeq)return;state.plan=value.plan||null;if(state.tab==='plan')renderPlan()}catch(error){if(sid()!==sessionID||state.planSeq!==planSeq)return;state.plan=null;console.debug('unified plan',error)}}

function renderCurrent(){
  ensureUI()
  if(state.tab==='activity')renderActivity()
  else if(state.tab==='plan')renderPlan()
  else if(state.tab==='changes')renderChanges()
  else if(state.tab==='verification')renderVerification()
  else if(state.tab==='runtime')renderRuntime()
  else if(state.tab==='rag')renderRag()
  else if(state.tab==='search')renderSearchShell()
}

function renderActivity(){
  const host=$('unified-activity');if(!host)return
  const oldBottom=host.scrollHeight-host.scrollTop
  host.innerHTML=state.activity.map(event=>`<div class="unified-event" data-group="${esc(event.group||'system')}"><div class="unified-event-head"><span class="unified-pill">${esc(event.group||'system')}</span><span class="unified-event-kind">${esc(event.kind||'event')}</span><time>${esc(timeLabel(event.createdAt))}</time></div>${event.data&&Object.keys(event.data).length?`<div class="unified-event-data">${esc(JSON.stringify(event.data,null,2).slice(0,1200))}</div>`:''}</div>`).join('')||'<div class="unified-card unified-muted">No runtime events for this session yet.</div>'
  renderActivityFollow()
  if(state.followActivity)requestAnimationFrame(()=>{host.scrollTop=host.scrollHeight})
  else host.scrollTop=Math.max(0,host.scrollHeight-oldBottom)
}
function renderActivityFollow(){const host=$('unified-activity');if(!host)return;host.querySelector('.unified-follow')?.remove();if(state.unseen>0){const button=document.createElement('button');button.className='unified-follow';button.type='button';button.textContent=`↓ ${state.unseen} new`;button.addEventListener('click',()=>{state.followActivity=true;state.unseen=0;host.scrollTop=host.scrollHeight;renderActivityFollow()});host.append(button)}}

function renderPlan(){const host=$('unified-plan');if(!host)return;const plan=state.plan;if(!plan){host.innerHTML='<div class="unified-card unified-muted">No native V2 plan document yet.</div>';return}const total=Number(plan.total??plan.todos?.length??0),completed=Number(plan.completed??(plan.todos||[]).filter(item=>item.status==='completed').length),pct=total?Math.round(completed/total*100):0;host.innerHTML=`<div class="unified-card"><h4>${esc(plan.title||'Plan')}</h4><div class="unified-row"><span>Progress</span><strong>${completed}/${total} · ${pct}%</strong></div><div class="unified-muted">${esc(plan.filename||plan.source||'native-v2')}</div></div>${(plan.todos||[]).map(item=>`<div class="unified-plan-item ${item.status==='completed'?'done':''}"><span class="unified-plan-mark">${item.status==='completed'?'✓':item.status==='in_progress'?'●':'○'}</span><span>${esc(item.content||'')}</span></div>`).join('')}`}

function renderChanges(){const host=$('unified-changes');if(!host)return;const git=state.snapshot?.project?.git;if(!git?.available){host.innerHTML='<div class="unified-card unified-muted">Git repository is not available for the current session.</div>';return}host.innerHTML=`<div class="unified-card"><h4>Repository</h4><div class="unified-row"><span>Branch</span><strong>${esc(git.branch||'detached')}</strong></div><div class="unified-row"><span>Changed</span><strong>${Number(git.changed||0)}</strong></div><div class="unified-actions"><button id="unifiedOpenChanges" type="button">Open diff/revert</button></div></div>${(git.files||[]).map(file=>`<div class="unified-file"><span class="unified-file-status">${esc(file.status)}</span><span>${esc(file.path)}</span></div>`).join('')||'<div class="unified-muted">Working tree clean.</div>'}`;$('unifiedOpenChanges')?.addEventListener('click',()=>$('gitButton')?.click())}

function renderVerification(){const host=$('unified-verification');if(!host)return;const verification=state.snapshot?.project?.verification||{};const recovery=state.snapshot?.project?.recovery||{};host.innerHTML=`<div class="unified-card ${statusClass(verification.ok)}"><h4>Verification</h4><div class="unified-row"><span>State</span><strong>${esc(verification.state||'idle')}</strong></div><div class="unified-row"><span>Task</span><code>${esc(verification.taskID||'—')}</code></div>${(verification.results||[]).slice(0,20).map(item=>`<div class="unified-row"><span>${esc(item.name||item.kind||'check')}</span><strong>${esc(item.ok===true?'PASS':item.ok===false?'FAIL':item.state||'—')}</strong></div>`).join('')}</div><div class="unified-card"><h4>Recovery</h4>${(recovery.items||[]).map(item=>`<div class="unified-event"><div class="unified-event-head"><span class="unified-pill">${esc(item.state)}</span><code>${esc(item.taskID)}</code></div><div class="unified-event-data">${esc(item.error||item.checkpoint?.summary||'')}</div><div class="unified-actions">${(item.actions||[]).map(action=>`<button data-recovery-action="${esc(action)}" data-task-id="${esc(item.taskID)}" data-checkpoint-id="${esc(item.checkpoint?.id||'')}">${esc(action.replace(/^task\.|^time\./,''))}</button>`).join('')}</div></div>`).join('')||'<div class="unified-muted">Nothing requires recovery.</div>'}</div>`;host.querySelectorAll('[data-recovery-action]').forEach(button=>button.addEventListener('click',()=>runServerAction(button.dataset.recoveryAction,{taskID:button.dataset.taskId,checkpointID:button.dataset.checkpointId})))}

function renderRuntime(){const host=$('unified-runtime');if(!host)return;const project=state.snapshot?.project||{},tasks=project.tasks||{},profile=project.resourceProfile||{};const counts=tasks.counts||{};host.innerHTML=`<div class="unified-card"><h4>Project Control Center</h4><div class="unified-row"><span>Directory</span><code>${esc(project.directory||'—')}</code></div><div class="unified-row"><span>Active</span><strong>${(tasks.active||[]).length}</strong></div><div class="unified-row"><span>Queued</span><strong>${(tasks.queued||[]).length}</strong></div><div class="unified-row"><span>States</span><span>${esc(Object.entries(counts).map(([name,count])=>`${name} ${count}`).join(' · ')||'—')}</span></div></div><div class="unified-card"><h4>Resource profile</h4><div class="unified-muted">Explicit policy only; it never silently replaces a manually selected model.</div><div class="unified-profiles">${(state.snapshot?.resourceProfiles||[]).map(item=>`<button class="unified-profile ${item.id===profile.id?'active':''}" data-resource-profile="${esc(item.id)}"><strong>${esc(item.title)}</strong><div class="unified-muted">${esc(item.description)}</div></button>`).join('')}</div></div><div class="unified-card"><h4>Task runtime</h4>${(tasks.active||[]).slice(0,12).map(task=>`<div class="unified-event"><div class="unified-event-head"><span class="unified-pill">${esc(task.state)}</span><strong>${esc(task.kind||'task')}</strong></div><div class="unified-event-data">${esc(task.text||'')}</div></div>`).join('')||'<div class="unified-muted">No active tasks.</div>'}<div class="unified-actions"><button id="unifiedAdvancedRuntime" type="button">Advanced runtime</button><button data-open-tab="verification" type="button">Recovery</button></div></div>`;host.querySelectorAll('[data-resource-profile]').forEach(button=>button.addEventListener('click',()=>runServerAction(`resource.profile.${button.dataset.resourceProfile}`,{})));$('unifiedAdvancedRuntime')?.addEventListener('click',()=>window.CustomOpenCodeRuntime?.open?.());host.querySelectorAll('[data-open-tab]').forEach(button=>button.addEventListener('click',()=>setTab(button.dataset.openTab)))}

function renderRag(){const host=$('unified-rag');if(!host)return;const project=state.snapshot?.project||{},mcp=project.mcp||{},settings=project.projectSettings||{};const namespaces=mcp.namespaces||[];host.innerHTML=`<div class="unified-card"><h4>RAG / MCP</h4><div class="unified-row"><span>Policy</span><strong>${esc(settings.rag||'auto')}</strong></div>${namespaces.map(item=>`<div class="unified-row"><span>${esc(item.namespace||'mcp')}</span><strong>${esc(typeof item.status==='string'?item.status:JSON.stringify(item.status||{}))}</strong></div>`).join('')||'<div class="unified-muted">No MCP health data.</div>'}<div class="unified-actions"><button id="unifiedRagStart" type="button">Start / verify RAG</button></div></div>`;$('unifiedRagStart')?.addEventListener('click',()=>prefillCommand('/rag-start'))}

function renderSearchShell(){const host=$('unified-search');if(!host)return;const existing=$('unifiedSearchInput')?.value||'';host.innerHTML=`<div class="unified-search"><input id="unifiedSearchInput" value="${esc(existing)}" placeholder="Tasks, events, repo symbols…"><button id="unifiedSearchButton" type="button">Search</button></div><div id="unifiedSearchResults">${state.search.map(renderSearchResult).join('')}</div>`;$('unifiedSearchButton').addEventListener('click',globalSearch);$('unifiedSearchInput').addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();globalSearch()}})}
function renderSearchResult(item){const title=item.title||item.qualified||item.path||item.kind||item.type;return `<div class="unified-result"><div class="unified-event-head"><span class="unified-pill">${esc(item.type||'result')}</span><strong>${esc(title||'Result')}</strong></div>${item.state?`<div class="unified-muted">${esc(item.state)}</div>`:''}${item.data?`<div class="unified-event-data">${esc(JSON.stringify(item.data).slice(0,800))}</div>`:''}</div>`}
async function globalSearch(){const input=$('unifiedSearchInput');const query=input?.value.trim()||'';if(!query||!sid())return;try{const value=await req(`${qs('/client-global-search.json')}&q=${encodeURIComponent(query)}&limit=80`);state.search=value.results||[];renderSearchShell();requestAnimationFrame(()=>{$('unifiedSearchInput')?.focus();$('unifiedSearchInput')?.setSelectionRange(query.length,query.length)})}catch(error){toast(`Search: ${error.message}`)}}

function prefillCommand(command){const input=$('input');if(!input)return;input.value=command;input.dispatchEvent(new Event('input',{bubbles:true}));input.focus();closePalette();closePanel()}

function wizardError(form,message){const error=form.querySelector('[data-wizard-error]');if(error){error.textContent=message;error.hidden=!message}}
function wizardValue(form,name){return String(form.elements[name]?.value||'').trim()}
function validID(value){return /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(value)}
const sensitiveName=/(?:^|[-_])(?:api[-_]?key|key|token|access[-_]?token|secret|password|passphrase|authorization|auth|credential)(?:$|[-_])/i
function isSensitiveName(value){return sensitiveName.test(String(value).replace(/([a-z])([A-Z])/g,'$1_$2'))}
function credential(name,value){if(isSensitiveName(name)&&!/^\{env:[A-Z_][A-Z0-9_]*\}$/.test(String(value||'').trim()))throw new Error(`${name} must use {env:VAR}.`)}
function localCredentialArgument(argument){const value=String(argument||''),assignment=/^([A-Za-z_][A-Za-z0-9_-]*)=(.*)$/.exec(value),header=/^([^:]+):\s*(.*)$/.exec(value);if(assignment)credential(assignment[1],assignment[2]);else if(header)credential(header[1],header[2])}
function parseLocalCommand(value){let command;try{command=JSON.parse(value)}catch{throw new Error('Local command must be a JSON array of strings.')}if(!Array.isArray(command)||!command.length||command.some(item=>typeof item!=='string'||!item.trim()))throw new Error('Local command must be a non-empty JSON array of strings.');for(let index=0;index<command.length;index+=1){const argument=command[index],flag=/^--([^=]+)(?:=(.*))?$/i.exec(argument);if(flag&&isSensitiveName(flag[1]))credential(flag[1],flag[2]===undefined?command[++index]:flag[2]);else if(flag&&/^(?:env|header)$/i.test(flag[1]))localCredentialArgument(flag[2]===undefined?command[++index]:flag[2]);else if(/^-[eH]$/.test(argument))localCredentialArgument(command[++index]);else localCredentialArgument(argument)}return command}
function safeRemoteMcpURL(value){let url;try{url=new URL(value)}catch{throw new Error('Remote MCP requires an http(s) URL.')}if(!['http:','https:'].includes(url.protocol))throw new Error('Remote MCP requires an http(s) URL.');if(url.username||url.password)throw new Error('Remote MCP URL must not include credentials.');for(const [key,item] of url.searchParams)credential(key,item);return value}

function openConfigWizard(kind){
  const session=sid()
  if(!session){toast('Select an active session before adding configuration.');return}
  closePalette()
  const isMcp=kind==='mcp'
  const dialog=document.createElement('dialog')
  dialog.className='unified-wizard'
  dialog.setAttribute('aria-label',isMcp?'Add MCP server':'Add skill')
  dialog.innerHTML=isMcp?`<form method="dialog" class="unified-wizard-form"><div class="unified-wizard-head"><h3>Add MCP server</h3><button type="button" data-wizard-close aria-label="Close">×</button></div><p class="unified-muted">Credentials must use env references. Known credential-bearing URL parameters and command arguments are rejected when literal; arbitrary positional values are not inferred.</p><label>Name<input name="name" required maxlength="64" autocomplete="off" pattern="[A-Za-z][A-Za-z0-9._-]{0,63}"></label><label>Type<select name="type"><option value="remote">Remote</option><option value="local">Local</option></select></label><label data-mcp-remote>URL<input name="url" type="url" placeholder="https://mcp.example.com" autocomplete="url"></label><label data-mcp-local hidden>Command (JSON array)<textarea name="command" rows="3" placeholder='["npx","-y","example-mcp"]'></textarea></label><div class="unified-wizard-checks"><label><input name="codemode" type="checkbox"> Code mode</label><label><input name="disabled" type="checkbox"> Disabled</label></div><div class="unified-wizard-error" data-wizard-error hidden role="alert"></div><div class="unified-wizard-actions"><button type="button" data-wizard-close>Cancel</button><button type="submit">Save MCP</button></div></form>`:`<form method="dialog" class="unified-wizard-form"><div class="unified-wizard-head"><h3>Add skill</h3><button type="button" data-wizard-close aria-label="Close">×</button></div><label>ID<input name="id" required maxlength="64" autocomplete="off" pattern="[A-Za-z][A-Za-z0-9._-]{0,63}"></label><label>Name<input name="name" required autocomplete="off"></label><label>Description<textarea name="description" rows="2" required></textarea></label><label>Content<textarea name="content" rows="9" required></textarea></label><label class="unified-wizard-check"><input name="autoinvoke" type="checkbox"> Autoinvoke</label><div class="unified-wizard-error" data-wizard-error hidden role="alert"></div><div class="unified-wizard-actions"><button type="button" data-wizard-close>Cancel</button><button type="submit">Save skill</button></div></form>`
  document.body.append(dialog)
  const form=dialog.querySelector('form')
  const close=()=>dialog.close()
  dialog.querySelectorAll('[data-wizard-close]').forEach(button=>button.addEventListener('click',close))
  dialog.addEventListener('click',event=>{if(event.target===dialog)close()})
  dialog.addEventListener('close',()=>dialog.remove(),{once:true})
  const type=form.elements.type
  const syncType=()=>{if(!type)return;const remote=type.value==='remote';form.querySelector('[data-mcp-remote]').hidden=!remote;form.querySelector('[data-mcp-local]').hidden=remote;form.elements.url.required=remote;form.elements.command.required=!remote}
  type?.addEventListener('change',syncType);syncType()
  form.addEventListener('submit',async event=>{
    event.preventDefault()
    if(form.dataset.pending)return
    wizardError(form,'')
    let input
    try{
      if(isMcp){const name=wizardValue(form,'name'),type=wizardValue(form,'type');if(!validID(name))throw new Error('Name must start with a letter and be at most 64 characters.');const config={type,codemode:form.elements.codemode.checked,disabled:form.elements.disabled.checked};if(type==='remote')config.url=safeRemoteMcpURL(wizardValue(form,'url'));else config.command=parseLocalCommand(wizardValue(form,'command'));input={name,config}}
      else{const id=wizardValue(form,'id'),name=wizardValue(form,'name'),description=wizardValue(form,'description'),content=wizardValue(form,'content');if(!validID(id))throw new Error('ID must start with a letter and be at most 64 characters.');if(!name||!description||!content)throw new Error('Name, description, and content are required.');input={id,name,description,content,autoinvoke:form.elements.autoinvoke.checked}}
    }catch(error){wizardError(form,error.message);return}
    form.dataset.pending='1';const submit=form.querySelector('[type="submit"]');submit.disabled=true
    try{await req(`/api/session/${encodeURIComponent(session)}/command`,{method:'POST',body:JSON.stringify({command:isMcp?'addmcp':'addskill',text:JSON.stringify(input)})});close();toast(`${isMcp?'MCP':'Skill'} saved`);await refreshAll(true)}catch(error){wizardError(form,`Save failed: ${error.message}`);submit.disabled=false;delete form.dataset.pending}
  })
  dialog.showModal()
  requestAnimationFrame(()=>form.elements[isMcp?'name':'id'].focus())
}

async function runServerAction(action,extra={}){try{const value=await req('/client-unified-action.json',{method:'POST',body:JSON.stringify({action,sessionID:sid(),...extra})});if(action==='time.fork'&&value.session?.id){location.hash=`#/session/${encodeURIComponent(value.session.id)}`;toast('Forked from checkpoint')}else toast(`${action}: ok`);await refreshAll(true)}catch(error){toast(`${action}: ${error.message}`)}}

function runAction(id){if(id==='mcp.add'){openConfigWizard('mcp');return}if(id==='skill.add'){openConfigWizard('skill');return}const action=state.actions.find(item=>item.id===id);if(!action)return;if(id.startsWith('panel.')){closePalette();openPanel(id.slice('panel.'.length));return}if(id==='project.control'){closePalette();openPanel('runtime');return}if(id==='search.global'){closePalette();openPanel('search');requestAnimationFrame(()=>$('unifiedSearchInput')?.focus());return}if(action.surface==='slash'&&action.command){prefillCommand(action.command);return}if(action.surface==='server'){if(id.startsWith('resource.profile.'))runServerAction(id);else{closePalette();openPanel(id==='time.fork'?'verification':'runtime');toast('Select a task in Recovery/Runtime to run this action.')}return}}

function filteredActions(){const query=($('unifiedPaletteInput')?.value||'').trim().toLowerCase();const actions=state.actions.length?state.actions:defaultActions();if(!query)return actions;return actions.filter(item=>`${item.title} ${item.group} ${item.id} ${item.command||''}`.toLowerCase().includes(query))}
function defaultActions(){return[
  {id:'panel.activity',title:'Activity',group:'Panel',surface:'client'},
  {id:'panel.plan',title:'Plan',group:'Panel',surface:'client'},
  {id:'panel.changes',title:'Changes',group:'Panel',surface:'client'},
  {id:'panel.verification',title:'Verification',group:'Panel',surface:'client'},
  {id:'panel.runtime',title:'Runtime',group:'Panel',surface:'client'},
  {id:'panel.rag',title:'RAG / MCP',group:'Panel',surface:'client'},
  {id:'search.global',title:'Global Search',group:'Project',surface:'client'},
]}
function renderPalette(){const host=$('unifiedPaletteList');if(!host)return;const actions=filteredActions();state.selectedCommand=Math.max(0,Math.min(state.selectedCommand,Math.max(0,actions.length-1)));host.innerHTML=actions.map((item,index)=>`<button type="button" class="unified-command ${index===state.selectedCommand?'selected':''}" data-unified-command="${esc(item.id)}"><span>${esc(item.title)}</span>${item.command?`<code>${esc(item.command)}</code>`:''}<span class="unified-command-group">${esc(item.group||'')}</span>${item.shortcut?`<span class="unified-command-shortcut">${esc(item.shortcut)}</span>`:''}</button>`).join('')||'<div class="unified-card unified-muted">No matching actions.</div>'}
function openPalette(){ensureUI();$('unifiedPalette').hidden=false;state.selectedCommand=0;$('unifiedPaletteInput').value='';renderPalette();requestAnimationFrame(()=>$('unifiedPaletteInput').focus())}
function closePalette(){if($('unifiedPalette'))$('unifiedPalette').hidden=true}

function bindKeys(){document.addEventListener('keydown',event=>{const key=event.key.toLowerCase();if((event.ctrlKey&&key==='k')||(event.ctrlKey&&event.shiftKey&&key==='p')){event.preventDefault();openPalette();return}if(event.key==='Escape'){if(!$('unifiedPalette')?.hidden){closePalette();return}if(state.open)closePanel()}if(event.ctrlKey&&event.altKey&&!event.shiftKey){if(key==='a'){event.preventDefault();openPanel('activity')}else if(key==='p'){event.preventDefault();openPanel('plan')}else if(key==='c'){event.preventDefault();openPanel('runtime')}}},true)}

function boot(){ensureUI();bindKeys();window.addEventListener('hashchange',()=>{state.refreshSeq+=1;state.planSeq+=1;state.activity=[];state.plan=null;state.lastEventID=0;state.unseen=0;state.followActivity=true;if(state.open)refreshAll(true)});window.addEventListener('custom-opencode:session-selected',()=>{if(state.open)refreshAll(true)});setTimeout(()=>refreshAll(true),500)}

window.CustomOpenCodeWorkspace={open:openPanel,close:closePanel,tab:setTab,refresh:()=>refreshAll(true),palette:openPalette,action:runAction}
boot()
