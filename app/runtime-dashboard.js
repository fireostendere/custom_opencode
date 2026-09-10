import { createAdaptivePoller, createRefreshCoalescer } from './refresh-coalescer.js'
const $=(id)=>document.getElementById(id)
const PROFILE_KEY='opencode:web:runtime-profile-v2:'

const state={sessionID:null,tasks:[],counts:{},capabilities:null,resources:null,selectedTask:null,previous:new Map(),unavailable:false,error:'',loading:false,updatedAt:null}
const refreshOnce=createRefreshCoalescer()

function esc(value){return String(value??'').replace(/[&<>"']/g,(c)=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}
function sid(){const m=/^#\/session\/([^/?]+)/.exec(location.hash||'');return m?decodeURIComponent(m[1]):null}
function key(){return `${PROFILE_KEY}${sid()||'draft'}`}
function explicitProfile(){return localStorage.getItem(key())||'direct'}
function canonicalProfile(id){return ({orchestrated:'architect','qwen3.8-orchestrated':'architect','gpt-5.6-sol-orchestrated':'sol-orchestrated'})[id]||id}
function profile(){
  const selected=canonicalProfile(explicitProfile());if(selected!=='direct')return selected
  const model=window.CustomOpenCodeControls?.activeModel?.()
  if(model?.providerID==='openai'&&model.id==='gpt-5.6-sol-orchestrated')return 'sol-orchestrated'
  if(model?.providerID==='bailian-cli'&&model.id==='qwen3.8-orchestrated')return 'architect'
  return 'direct'
}
function profileRow(id){return state.capabilities?.profiles?.find((item)=>item.id===canonicalProfile(id))||null}
const PROFILE_LABELS={direct:'Модель чата',architect:'Qwen · Оркестрация','sol-orchestrated':'Sol · Оркестрация','sol-review':'Sol · Ревью',fast:'Быстрая задача',build:'Разработка',critical:'Критическая задача',review:'Независимое ревью',research:'Исследование','long-horizon':'Длительная задача'}
const STATE_LABELS={queued:'В очереди',blocked:'Ждёт зависимостей',paused:'Приостановлена',submitted:'Отправлена модели',running:'Выполняется',waiting_permission:'Ждёт разрешения',verifying:'Проверяется',recovering:'Восстанавливается',needs_attention:'Нужна помощь',completed:'Завершена',failed:'Ошибка',cancelled:'Отменена'}
function profileLabel(id){return PROFILE_LABELS[canonicalProfile(id)]||profileRow(id)?.label||id}
function stateLabel(id){return STATE_LABELS[id]||id}
function nextModel(){const ref=window.CustomOpenCodeControls?.activeModel?.();return state.resources?.decisions?.[profile()]?.selectedModel||profileRow(profile())?.cloudModel||(ref?.providerID&&ref?.id?`${ref.providerID}/${ref.id}`:'Данные ещё не загружены')}
function setProfile(id,label=''){localStorage.setItem(key(),id||'direct');document.documentElement.dataset.runtimeProfile=id||'direct';syncBadge(label);renderProfiles()}
function toast(text){const el=$('toast');if(!el)return;el.textContent=text;el.hidden=false;clearTimeout(el._runtimeTimer);el._runtimeTimer=setTimeout(()=>el.hidden=true,3200)}
async function req(path,options={}){const response=await fetch(path,{...options,headers:{'Content-Type':'application/json',...(options.headers||{})}});if(!response.ok){const text=await response.text().catch(()=>'');throw new Error(`${response.status} ${response.statusText}${text?`: ${text.slice(0,240)}`:''}`)}const type=response.headers.get('content-type')||'';return type.includes('application/json')?response.json():response.text()}

// Preserve the existing composer/queue implementation and attach only the server profile.
const nativeFetch=window.fetch.bind(window)
window.fetch=async(input,options={})=>{try{const raw=typeof input==='string'?input:input?.url||'';const path=new URL(raw,location.href).pathname;if((path==='/client-send.json'||path==='/client-queue.json')&&String(options.method||'GET').toUpperCase()==='POST'&&typeof options.body==='string'){const body=JSON.parse(options.body);if(body&&typeof body==='object'){body.profile=profile();options={...options,body:JSON.stringify(body)}}}}catch{}return nativeFetch(input,options)}

function ensureUI(){
  $('runtimeProfileBadge')?.remove()
  if(!$('taskCenterButton')){const button=document.createElement('button');button.id='taskCenterButton';button.type='button';button.className='header-chip task-center-open';button.textContent='Tasks';button.title='Server tasks, checkpoints, usage and resources';$('gitButton')?.after(button);button.addEventListener('click',openCenter)}
  if(!$('taskCenterDialog')){
    const dialog=document.createElement('dialog');dialog.id='taskCenterDialog'
    dialog.innerHTML=`<div class="modal runtime-modal">
      <div class="modal-head"><div><h3>Задачи и состояние</h3><div id="runtimeSummary" class="runtime-subtitle">Загрузка…</div></div><button class="icon" type="button" data-runtime-close aria-label="Закрыть">×</button></div>
      <p class="runtime-help">История задач, отправленных через веб в этом чате. «Завершена» означает, что обработка закончена, а не гарантирует правильность результата. Нажмите задачу, чтобы увидеть ошибку и результаты проверок.</p>
      <div id="runtimeTop" class="runtime-top"></div>
      <details class="runtime-section" id="runtimeProfileOptions"><summary>Изменить режим следующих задач</summary>
        <p class="runtime-help">Выбор сохраняется для этого чата в этом браузере и применяется при отправке следующей задачи. Уже запущенные и поставленные в очередь задачи не меняются. «Модель чата» следует основному выбору модели.</p>
        <div id="runtimeProfiles" class="runtime-profiles"></div>
      </details>
      <div class="runtime-section"><div class="runtime-section-head"><strong>Задачи этого чата</strong><button id="runtimeRefresh" type="button">Обновить</button></div><div id="runtimeTasks" class="runtime-tasks"></div></div>
      <div class="runtime-section" id="runtimeTaskDetailSection" hidden><div class="runtime-section-head"><strong>Подробности задачи</strong><button id="runtimeCloseDetail" type="button">Скрыть</button></div><div id="runtimeTaskDetail" class="runtime-task-detail"></div></div>
      <details class="runtime-section"><summary>Дополнительные действия</summary><p class="runtime-help">Используют текст из поля сообщения. Создают новые задачи и расходуют токены. Отдельная копия проекта требует Git; результаты не сливаются автоматически.</p><div class="runtime-head-actions"><button id="runtimeIsolated" type="button">Задача в отдельной копии проекта</button><button id="runtimeSpeculate" type="button">Два параллельных исследования</button></div></details>
    </div>`
    document.body.append(dialog);dialog.querySelector('[data-runtime-close]').addEventListener('click',()=>dialog.close());$('runtimeRefresh').addEventListener('click',()=>refresh(true));$('runtimeCloseDetail').addEventListener('click',()=>{$('runtimeTaskDetailSection').hidden=true;state.selectedTask=null});$('runtimeSpeculate').addEventListener('click',speculate);$('runtimeIsolated').addEventListener('click',isolated);dialog.addEventListener('click',(event)=>{if(event.target===dialog)dialog.close()})
  }
  const refreshButton=$('runtimeRefresh'),heading=$('taskCenterDialog')?.querySelector('.modal-head')
  if(refreshButton&&heading&&!heading.contains(refreshButton))heading.insertBefore(refreshButton,heading.lastElementChild)
  syncBadge()
}
function syncBadge(label=''){const badge=$('runtimeProfileBadge');if(!badge)return;const id=profile();badge.textContent=label||profileRow(id)?.label||(id==='direct'?'Direct':id);badge.dataset.profile=id;badge.title=id==='direct'?'Selected OpenCode model':'Server model profile'}

async function capabilities(){const session=sid();if(!session)return;try{const value=await req(`/client-model-capabilities.json?sessionID=${encodeURIComponent(session)}`);if(sid()!==session)return;state.capabilities=value;syncBadge();renderProfiles()}catch(error){console.debug('runtime capabilities',error)}}
function renderProfiles(){
  const host=$('runtimeProfiles');if(!host)return
  const current=canonicalProfile(explicitProfile()),profiles=state.capabilities?.profiles||[]
  const markup=profiles.map(item=>{
    const description=item.route==='selected'?'Сохранять выбранную модель и её оркестрацию':`${item.orchestrated?'Планирование и делегирование':'Одна модель'}${item.agentBuild?.startsWith('plan')?' · режим анализа':''}`
    return `<button type="button" class="runtime-profile ${item.id===current?'active':''}" aria-pressed="${item.id===current}" data-runtime-profile="${esc(item.id)}"><strong>${esc(profileLabel(item.id))}</strong><span>${esc(description)}</span>${item.cloudModel?`<span class="runtime-profile-model">${esc(item.cloudModel)}</span>`:''}</button>`
  }).join('')||'<div class="empty">Профили не загружены. Нажмите «Обновить».</div>'
  if(host._lastMarkup===markup)return
  host._lastMarkup=markup;host.innerHTML=markup
  host.querySelectorAll('[data-runtime-profile]').forEach(button=>button.addEventListener('click',()=>chooseProfile(button.dataset.runtimeProfile)))
}
function chooseProfile(id){if(!profileRow(id))return;setProfile(id);render();toast(`Для следующих задач: ${profileLabel(id)}. Текущая задача не изменена.`)}


function activeCount(){return state.tasks.filter((task)=>['queued','blocked','paused','submitted','running','waiting_permission','verifying','recovering'].includes(task.state)).length}
function refresh(force=false){return refreshOnce(()=>refreshNow(force),force)}
async function refreshNow(force=false){
  const session=sid()
  state.sessionID=session
  if(!session){state.tasks=[];state.counts={};state.unavailable=false;state.error='';render();return}
  if(state.unavailable&&!force)return
  state.loading=true;render()
  try{
    const tasks=await req(`/client-tasks.json?sessionID=${encodeURIComponent(session)}&limit=200`)
    if(sid()!==session)return
    state.tasks=tasks?.tasks||[];state.counts=tasks?.counts||{};state.unavailable=tasks?.available===false;state.error=''
    if($('taskCenterDialog')?.open&&!state.unavailable){
      const resources=await req('/client-resource-status.json')
      if(sid()!==session)return
      state.resources=resources
      if(force||!state.capabilities)await capabilities()
      if(sid()!==session)return
      if(state.selectedTask)await detail(state.selectedTask,false)
    }
    state.updatedAt=Date.now();notifyTransitions()
  }catch(error){if(sid()===session)state.error='Не удалось обновить задачи. Повторим позже; можно нажать «Обновить».'}
  finally{if(sid()===session){state.loading=false;render()}}
}
const polling=createAdaptivePoller({run:refresh,isActive:()=>!state.error&&!!$('taskCenterDialog')?.open,activeDelay:5000,idleDelay:30000,isVisible:()=>!document.hidden})
function render(){
  ensureUI();
  const active=activeCount();
  const btn=$('taskCenterButton');
  if(btn){
    btn.dataset.attention=String(state.unavailable||!!state.error)
    btn.textContent=state.unavailable?'Задачи · недоступны':state.error?'Задачи · нет связи':active?`Задачи ${active}`:'Задачи'
    btn.title=state.unavailable?'Проект вне разрешённых корней: серверные задачи недоступны. Диалог работает.':state.error||'Задачи, результаты и состояние сервера'
    btn.setAttribute('aria-busy',String(state.loading))
  }
  const dlg=$('taskCenterDialog');
  if(!dlg||!dlg.open)return;
  dlg.dataset.unavailable=String(state.unavailable)
  dlg.querySelector('h3').textContent='Задачи и состояние'
  for(const id of ['runtimeTop','runtimeV3Panel','runtimeProfiles','runtimeTasks']){
    const el=$(id);if(el)(id==='runtimeProfiles'||id==='runtimeTasks'?el.closest('.runtime-section'):el).hidden=state.unavailable
  }
  if(state.unavailable)$('runtimeTaskDetailSection').hidden=true
  const summaryText=state.unavailable?'Проект вне разрешённых корней. Серверные задачи недоступны; диалог продолжает работать.':state.error|| (state.loading?'Обновление…':`${Object.entries(state.counts).map(([name,count])=>`${stateLabel(name)}: ${count}`).join(' · ')||'Задач пока нет'}${state.updatedAt?` · Обновлено ${new Date(state.updatedAt).toLocaleTimeString()}`:''}`);
  const sumEl=$('runtimeSummary');
  if(sumEl){sumEl.setAttribute('role','status');if(sumEl.textContent!==summaryText)sumEl.textContent=summaryText}
  const topMarkup=`<div class="runtime-stat"><span>Режим следующих задач</span><strong>${esc(profileLabel(explicitProfile()))}</strong></div><div class="runtime-stat"><span>Модель следующей задачи</span><strong title="${esc(nextModel())}">${esc(nextModel())}</strong></div>`;
  const topEl=$('runtimeTop');
  if(topEl&&topEl._lastMarkup!==topMarkup){topEl._lastMarkup=topMarkup;topEl.innerHTML=topMarkup}
  renderProfiles();
  renderTasks();
}
function stateClass(value){return ['failed','needs_attention'].includes(value)?'danger':['running','submitted','verifying','waiting_permission'].includes(value)?'active':value==='completed'?'done':''}
function verificationLabel(task){const value=task.verification;if(value?.enabled===false)return 'Проверки не запускались';if(value?.ok===true)return 'Проверки пройдены';if(value?.ok===false)return 'Проверки не пройдены';return 'Нет результатов проверок'}
function renderTasks(){
  const host=$('runtimeTasks');
  if(!host)return;
  const markup=state.tasks.map((task)=>{
    const pause=['queued','blocked','running','submitted','waiting_permission'].includes(task.state);
    const resume=['paused','recovering','needs_attention'].includes(task.state);
    const cancel=!['completed','failed','cancelled'].includes(task.state);
    const queued=['queued','blocked','paused'].includes(task.state)
    const kind=({prompt:'Сообщение',research:'Исследование',review:'Ревью',aggregate:'Объединение результатов'})[task.kind]||task.kind||'Задача'
    return `<div class="runtime-task ${stateClass(task.state)}"><button class="runtime-task-main" type="button" data-task-detail="${esc(task.id)}"><div class="runtime-task-line"><span class="runtime-state">${esc(stateLabel(task.state))}</span><strong>${esc(kind)}</strong>${queued?`<span class="runtime-priority" title="Больше число — раньше запуск">Приоритет ${esc(task.priority)}</span>`:''}</div><div class="runtime-task-text">${esc(task.text||'—')}</div><div class="runtime-task-meta">Профиль: ${esc(profileLabel(task.profile))}${task.dependencies?.length?` · Зависимостей: ${task.dependencies.length}`:''}${task.route?.selectedModel?` · Основная модель: ${esc(task.route.selectedModel)}`:''}</div><div class="runtime-task-meta">${esc(verificationLabel(task))} · Открыть подробности</div>${task.error?`<div class="runtime-task-error">${esc(task.error)}</div>`:''}</button><div class="runtime-task-actions">${queued?`<button title="Понизить приоритет" aria-label="Понизить приоритет" data-priority="${esc(task.id)}:-10">−</button><button title="Повысить приоритет" aria-label="Повысить приоритет" data-priority="${esc(task.id)}:10">+</button><button data-deps="${esc(task.id)}">Зависимости</button>`:''}${pause?`<button data-action="${esc(task.id)}:pause">Пауза</button>`:''}${resume?`<button data-action="${esc(task.id)}:resume">Продолжить</button>`:''}${cancel?`<button class="runtime-danger" data-action="${esc(task.id)}:cancel">Отменить</button>`:''}</div></div>`
  }).join('')||'<div class="empty">Для этой сессии серверных задач ещё нет.</div>';
  if(host._lastMarkup===markup)return;
  host._lastMarkup=markup;
  host.innerHTML=markup;
  host.querySelectorAll('[data-task-detail]').forEach((b)=>b.addEventListener('click',()=>detail(b.dataset.taskDetail,true)));
  host.querySelectorAll('[data-action]').forEach((b)=>b.addEventListener('click',()=>{const [id,action]=b.dataset.action.split(':');control(id,action)}));
  host.querySelectorAll('[data-priority]').forEach((b)=>b.addEventListener('click',()=>{const [id,delta]=b.dataset.priority.split(':');const task=state.tasks.find((item)=>item.id===id);if(task)control(id,'priority',{priority:Number(task.priority||0)+Number(delta)})}));
  host.querySelectorAll('[data-deps]').forEach((b)=>b.addEventListener('click',()=>deps(b.dataset.deps)));
}
async function control(taskID,action,extra={}){try{await req('/client-task-control.json',{method:'POST',body:JSON.stringify({taskID,action,...extra})});await refresh(true)}catch(error){toast(`Task: ${error.message}`)}}
function deps(taskID){const task=state.tasks.find((item)=>item.id===taskID);if(!task)return;const raw=window.prompt('Task IDs через запятую. Задача ждёт их completed.',(task.dependencies||[]).join(','));if(raw==null)return;control(taskID,'dependencies',{dependencies:raw.split(',').map((item)=>item.trim()).filter(Boolean)})}
async function detail(taskID,show=true){
  const session=sid();state.selectedTask=taskID
  if(show){$('runtimeTaskDetailSection').hidden=false;$('runtimeTaskDetail').textContent='Загрузка…'}
  try{
    const value=await req(`/client-task.json?id=${encodeURIComponent(taskID)}`)
    if(sid()!==session||state.selectedTask!==taskID)return
    const task=value.task||{},usage=value.usage?.stages||{},checkpoints=value.checkpoints||[],events=value.events||[],artifacts=value.artifacts||[]
    $('runtimeTaskDetail').innerHTML=`
      <div class="runtime-detail-grid"><div><span>ID</span><code>${esc(task.id)}</code></div><div><span>Состояние</span><strong>${esc(stateLabel(task.state))}</strong></div><div><span>Профиль при запуске</span><strong>${esc(profileLabel(task.profile))}</strong></div><div><span>Основная модель</span><code>${esc(task.route?.selectedModel||'Не записана')}</code></div></div>
      <p>${esc(task.text||'')}</p>${task.error?`<div class="runtime-task-error">Ошибка: ${esc(task.error)}</div>`:''}
      <div class="runtime-detail-block"><strong>${esc(verificationLabel(task))}</strong>${(task.verification?.results||[]).map(item=>`<div class="runtime-event"><span>${esc(item.name||item.kind||'Проверка')}</span><span>${item.ok===true?'Пройдена':item.ok===false?'Не пройдена':'Результат не указан'}</span></div>`).join('')}</div>
      <div class="runtime-detail-block"><strong>Расход токенов по этапам</strong>${Object.entries(usage).map(([stage,row])=>`<div class="runtime-event"><span>${esc(stage)}</span><span>${Number(row.inputTokens||0).toLocaleString()} вход · ${Number(row.outputTokens||0).toLocaleString()} выход</span></div>`).join('')||'<div class="runtime-muted">Нет данных о расходе.</div>'}</div>
      <div class="runtime-detail-block"><strong>Контрольные точки</strong>${checkpoints.slice(0,12).map(item=>`<div class="runtime-event"><span>${esc(item.stage)}</span><span>${esc(item.summary||'')}</span></div>`).join('')||'<div class="runtime-muted">Нет сохранённых контрольных точек.</div>'}</div>
      <div class="runtime-detail-block"><strong>Файлы результата</strong>${artifacts.slice(0,12).map(item=>`<button class="runtime-artifact" data-artifact="${esc(item.id)}">${esc(item.title)} · ${(item.size/1024).toFixed(1)} KB</button>`).join('')||'<div class="runtime-muted">Файлы не записаны.</div>'}</div>
      <details class="runtime-detail-block"><summary>Технический журнал (${events.length})</summary><div class="runtime-events">${events.slice(-80).map(item=>`<div class="runtime-event"><span>${esc(item.kind)}</span><code>${esc(JSON.stringify(item.data||{}).slice(0,600))}</code></div>`).join('')}</div></details>`
    $('runtimeTaskDetail').querySelectorAll('[data-artifact]').forEach(button=>button.addEventListener('click',()=>artifact(button.dataset.artifact)))
  }catch(error){if(sid()===session&&state.selectedTask===taskID)$('runtimeTaskDetail').textContent=`Не удалось загрузить задачу: ${error.message}`}
}
async function artifact(id){try{const value=await req(`/client-artifact.json?id=${encodeURIComponent(id)}&limit=120000`);$('fileTitle').textContent=value.title||'Artifact';$('fileContent').textContent=typeof value.content==='string'?value.content:JSON.stringify(value.content,null,2);$('fileDialog').showModal()}catch(error){toast(`Artifact: ${error.message}`)}}
async function isolated(){const session=sid(),text=$('input')?.value.trim()||'';if(!session||!text){toast('Сначала введи задачу в composer');return}try{const value=await req('/client-task-create.json',{method:'POST',body:JSON.stringify({sessionID:session,text,isolate:true,profile:profile(),priority:10,mode:document.documentElement.dataset.executionMode||'build'})});toast(`Isolated task: ${value.task?.id||'created'}`);await refresh(true)}catch(error){toast(`Isolated task: ${error.message}`)}}
async function speculate(){const session=sid(),text=$('input')?.value.trim()||'';if(!session||!text){toast('Сначала введи задачу в composer');return}try{const value=await req('/client-speculate.json',{method:'POST',body:JSON.stringify({sessionID:session,text,count:2})});toast(`Запущено исследователей: ${value.children?.length||0}`);await refresh(true)}catch(error){toast(`Parallel research: ${error.message}`)}}
function notifyTransitions(){for(const task of state.tasks){const before=state.previous.get(task.id);state.previous.set(task.id,task.state);if(before&&before!==task.state&&['completed','needs_attention','failed','waiting_permission'].includes(task.state)&&'Notification'in window&&Notification.permission==='granted'){try{new Notification('OpenCode task',{body:`${task.kind}: ${task.state}`,tag:`runtime-${task.id}`})}catch{}}}}
async function openCenter(){ensureUI();$('taskCenterDialog').showModal();await refresh(true)}
function bind(){
  ensureUI();state.sessionID=sid();setProfile(explicitProfile())
  window.addEventListener('custom-opencode:model-changed',event=>{if(event.detail?.ok&&event.detail.sessionID===sid()){setProfile('direct');render()}})
  window.addEventListener('hashchange',()=>{if(state.sessionID===sid())return;state.sessionID=sid();state.capabilities=null;state.selectedTask=null;state.unavailable=false;state.error='';state.tasks=[];state.counts={};state.resources=null;state.updatedAt=null;$('runtimeTaskDetailSection').hidden=true;setProfile(explicitProfile());refresh(true)})
  document.addEventListener('visibilitychange',()=>{if(!document.hidden)polling.wake()});polling.start()
}
window.CustomOpenCodeRuntime={currentProfile:profile,setProfile,refresh,open:openCenter}
bind()
