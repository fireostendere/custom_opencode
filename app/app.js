import * as api from './api.js'
import { escapeHtml, renderMarkdown } from './markdown.js'

const $ = (id) => document.getElementById(id)
const QUICK_PROJECT_ID = '__custom_opencode_quick__'
const META_KEY = 'opencode:web:session-meta-v2'
const DRAFT_KEY = 'opencode:web:drafts-v2'
const FAV_KEY = 'opencode:web:favorites'
const NOTIFY_KEY = 'opencode:web:notifications'
const PERSONAL_PRO_LIMITS = { fiveHour: 12000, sevenDay: 40000 }
const QWEN_SUFFIX_RE = /\s·\sQwen\s+(OK|exhausted→([^·]+))\s*$/

const state = {
  clientConfig: null,
  sessions: [], projects: [], selected: null, context: [],
  agents: [], models: [], providers: [], defaultModel: null,
  draftAgent: null, draftModel: null, attachments: [],
  loading: false, running: new Map(), queues: new Map(), deliveryMode: 'steer',
  projectDialogMode: 'create', actionSession: null, pendingPermission: null,
  git: { vcs: null, files: [], diffs: [] }, notifyEnabled: localStorage.getItem(NOTIFY_KEY) === '1',
}
let sessionMeta = loadJson(META_KEY, {})
let drafts = loadJson(DRAFT_KEY, {})
let favorites = new Set(loadJson(FAV_KEY, []))
let contextReloadTimer = null
let draftSaveTimer = null
let permissionTimer = null
let statusTimer = null
let gitTimer = null
let eventSource = null

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || '') || fallback } catch { return fallback }
}
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)) }
function meta(id) { return sessionMeta[id] ||= { pinned:false, archived:false } }
function saveMeta() { saveJson(META_KEY, sessionMeta) }
function draftKey() { return state.selected?.id || '__new__' }
function saveDraftNow() { drafts[draftKey()] = $('input').value; saveJson(DRAFT_KEY, drafts) }
function restoreDraft() { $('input').value = drafts[draftKey()] || ''; autosizeInput() }
function scheduleDraftSave() { clearTimeout(draftSaveTimer); draftSaveTimer = setTimeout(saveDraftNow, 180) }
function toast(text, ms = 2600) { const el=$('toast'); el.textContent=text; el.hidden=false; clearTimeout(el._timer); el._timer=setTimeout(()=>el.hidden=true,ms) }

function stripQuota(title) { return String(title || '').replace(QWEN_SUFFIX_RE, '').trimEnd() }
function quotaFromTitle(title) {
  const match = QWEN_SUFFIX_RE.exec(String(title || ''))
  if (!match) return null
  return match[1] === 'OK' ? { state:'ok' } : { state:'exhausted', resetAt:(match[2] || '').trim() }
}
function latestQuota() {
  return [...state.sessions].sort((a,b)=>sessionTime(b)-sessionTime(a)).map((s)=>quotaFromTitle(s.title)).find(Boolean) || null
}
function projectMap() { return new Map(state.projects.map((project)=>[project.id,project])) }
function directory(session) { return session?.location?.directory || projectMap().get(session?.projectID)?.canonical || '' }
function projectLabel(project) { return project?.name || project?.canonical?.split(/[\\/]/).filter(Boolean).pop() || project?.id || 'Без проекта' }
function projectInfo(session) {
  if (session?.projectID === QUICK_PROJECT_ID) return { key:QUICK_PROJECT_ID, label:'Быстрые', directory:directory(session) }
  const project = projectMap().get(session?.projectID)
  const dir = directory(session)
  return { key:session?.projectID || dir || 'none', label:project ? projectLabel(project) : (dir.split(/[\\/]/).filter(Boolean).pop() || 'Без проекта'), directory:dir }
}
function sessionTitle(session) { return stripQuota(session?.title?.trim()) || 'Без названия' }
function sessionTime(session) { return session?.time?.updated || session?.time?.created || 0 }
function timeText(value) { return value ? new Date(value).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'}) : '' }
function activeModelRef() { return state.selected?.model || (!state.selected && state.draftModel) || state.defaultModel || null }
function activeModel() { const ref=activeModelRef(); return ref && state.models.find((m)=>m.id===ref.id && m.providerID===ref.providerID) }
function providerName(id) { return state.providers.find((p)=>p.id===id)?.name || id }
function isRunning(id) { return state.running.has(id) }
function queueFor(id) { if (!state.queues.has(id)) state.queues.set(id,[]); return state.queues.get(id) }
function normalizeRunStatus(value) {
  const raw = typeof value === 'string' ? value : value?.type || value?.status || value?.state || ''
  return String(raw).toLowerCase()
}
function runningStatus(value) { const s=normalizeRunStatus(value); return /running|busy|retry|working|pending/.test(s) }

async function loadSessions({ selectHash = false } = {}) {
  state.loading = true; renderSessions()
  try {
    const [projects, sessions, statuses] = await Promise.all([api.listProjects(), api.listSessions(), api.sessionStatuses()])
    state.projects = projects
    const unique = new Map(sessions.filter((s)=>!s?.parentID).map((s)=>[s.id,s]))
    state.sessions = [...unique.values()].sort((a,b)=>sessionTime(b)-sessionTime(a))
    for (const [id,status] of Object.entries(statuses || {})) {
      if (runningStatus(status)) state.running.set(id,{ status:normalizeRunStatus(status), since:Date.now() })
      else state.running.delete(id)
    }
    if (state.selected) state.selected = state.sessions.find((s)=>s.id===state.selected.id) || state.selected
    state.loading = false; renderSessions(); renderHeader(); updateBadge()
    if (selectHash && !state.selected) {
      const id = sessionIdFromHash()
      if (id && state.sessions.some((s)=>s.id===id)) await selectSession(id,{ push:false })
    }
  } catch (error) {
    state.loading = false
    $('sessions').innerHTML = `<div class="empty">Не удалось загрузить сессии.<br>${escapeHtml(error.message)}</div>`
    toast('Ошибка загрузки сессий')
  }
}

function renderSessions() {
  if (state.loading) { $('sessions').innerHTML='<div class="loading">Загрузка сессий…</div>'; return }
  const query = $('search').value.trim().toLowerCase()
  const showArchived = $('showArchived').checked
  const visible = state.sessions.filter((session)=>{
    const m=meta(session.id)
    if (m.archived && !showArchived) return false
    const info=projectInfo(session)
    return `${sessionTitle(session)} ${info.label} ${info.directory}`.toLowerCase().includes(query)
  }).sort((a,b)=>Number(meta(b.id).pinned)-Number(meta(a.id).pinned)||sessionTime(b)-sessionTime(a))
  if (!visible.length) { $('sessions').innerHTML='<div class="empty">Сессий не найдено.</div>'; return }
  const groups = new Map()
  for (const session of visible) {
    const info=projectInfo(session)
    if (!groups.has(info.key)) groups.set(info.key,{ info, items:[] })
    groups.get(info.key).items.push(session)
  }
  $('sessions').innerHTML=[...groups.values()].map(({info,items})=>`
    <div class="project" title="${escapeHtml(info.directory)}"><span>${escapeHtml(info.label)}</span><span class="count">${items.length}</span></div>
    ${items.map((session)=>{
      const running=isRunning(session.id), queued=queueFor(session.id).length, m=meta(session.id)
      return `<div class="session ${state.selected?.id===session.id?'active':''} ${m.pinned?'pinned':''}">
        <button class="session-main" data-session="${escapeHtml(session.id)}">
          <div class="session-title">${escapeHtml(sessionTitle(session))}</div>
          <div class="session-meta">${running?'<span class="run-dot"></span>':''}<span>${running?'Выполняется':timeText(sessionTime(session))}</span>${queued?`<span class="queued">очередь ${queued}</span>`:''}${m.archived?'<span>архив</span>':''}</div>
        </button><button class="session-more" data-session-more="${escapeHtml(session.id)}">•••</button>
      </div>`
    }).join('')}`).join('')
  document.querySelectorAll('[data-session]').forEach((button)=>button.addEventListener('click',()=>selectSession(button.dataset.session)))
  document.querySelectorAll('[data-session-more]').forEach((button)=>button.addEventListener('click',(event)=>{event.stopPropagation();openSessionActions(button.dataset.sessionMore)}))
}

async function selectSession(id,{push=true}={}) {
  const session=state.sessions.find((s)=>s.id===id); if(!session)return
  saveDraftNow()
  state.selected=session; state.context=[]; state.attachments=[]; state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
  renderAttachments(); renderSessions(); renderHeader(); renderMessages(); restoreDraft(); $('sidebar').classList.remove('open')
  if(push) setSessionHash(id)
  await Promise.all([loadContext(),loadControls(),refreshPermissions(),refreshGit()])
}
function clearSelection() {
  saveDraftNow(); state.selected=null;state.context=[];state.attachments=[];state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
  location.hash=''; renderSessions();renderHeader();renderMessages();renderAttachments();restoreDraft();loadDraftControls()
}
function setSessionHash(id) { const next=`#/session/${encodeURIComponent(id)}`; if(location.hash!==next) history.pushState(null,'',next) }
function sessionIdFromHash() { const match=/^#\/session\/([^/?]+)/.exec(location.hash); return match?decodeURIComponent(match[1]):null }

async function loadContext() {
  if(!state.selected)return
  const id=state.selected.id
  try { const context=await api.getContext(id); if(state.selected?.id!==id)return; state.context=context.filter((m)=>['user','assistant'].includes(m.type)||['user','assistant'].includes(m.role)); renderMessages(); renderUsage() }
  catch(error){ if(state.selected?.id===id)$('messagesInner').innerHTML=`<div class="empty">Не удалось открыть сессию: ${escapeHtml(error.message)}</div>` }
}
function scheduleContextReload(delay=250) { clearTimeout(contextReloadTimer); contextReloadTimer=setTimeout(()=>loadContext(),delay) }

async function loadControls() {
  if(!state.selected)return
  const id=state.selected.id
  try { const catalog=await api.getControls(directory(state.selected)); if(state.selected?.id!==id)return; applyControls(catalog) }
  catch(error){toast(`Настройки: ${error.message}`)}
}
async function loadDraftControls() {
  if(state.selected||!state.clientConfig?.scratchDirectory)return
  try { const catalog=await api.getControls(state.clientConfig.scratchDirectory); if(state.selected)return; state.draftAgent ||= catalog.agents.find((a)=>a.id==='build')?.id||catalog.agents[0]?.id; state.draftModel ||= catalog.fallback && {id:catalog.fallback.id,providerID:catalog.fallback.providerID}; applyControls(catalog) }
  catch(error){toast(`Настройки: ${error.message}`)}
}
function applyControls(catalog){state.agents=catalog.agents;state.models=catalog.models;state.providers=catalog.providers;state.defaultModel=catalog.fallback;renderControls();renderUsage()}
function renderControls(){
  const agentID=state.selected?.agent||(!state.selected&&state.draftAgent)||state.agents.find((a)=>a.id==='build')?.id||state.agents[0]?.id
  $('agentControls').innerHTML=state.agents.map((agent)=>`<button type="button" class="${agent.id===agentID?'active':''}" data-agent="${escapeHtml(agent.id)}">${escapeHtml(agent.name||agent.id)}</button>`).join('')
  document.querySelectorAll('[data-agent]').forEach((b)=>b.addEventListener('click',()=>changeAgent(b.dataset.agent)))
  const ref=activeModelRef(), model=activeModel(); $('modelButton').disabled=!state.models.length; $('modelButton').textContent=model?.name||ref?.id||'Модель'
  const variants=Array.isArray(model?.variants)?model.variants:Object.entries(model?.variants||{}).map(([id,v])=>({id,...v}))
  $('variantSelect').innerHTML=variants.length?`<option value="">Effort: default</option>${variants.map((v)=>`<option value="${escapeHtml(v.id)}">Effort: ${escapeHtml(v.id)}</option>`).join('')}`:'<option value="">Effort: —</option>'
  $('variantSelect').value=ref?.variant||''; $('variantSelect').disabled=!variants.length
}
async function changeAgent(agent){state.draftAgent=agent;if(!state.selected){renderControls();return}try{await api.switchAgent(state.selected.id,agent);state.selected.agent=agent;renderControls()}catch(e){toast(`Режим: ${e.message}`)}}
async function changeModel(model){state.draftModel=model;if(!state.selected){renderControls();return}try{await api.switchModel(state.selected.id,model);state.selected.model=model;renderControls();renderUsage()}catch(e){toast(`Модель: ${e.message}`)}}

function renderModelChoices(){
  const query=$('modelSearch').value.trim().toLowerCase(), current=activeModelRef()
  const models=state.models.filter((m)=>`${m.name||''} ${m.id} ${m.providerID}`.toLowerCase().includes(query))
  const groups=new Map(); for(const m of models){if(!groups.has(m.providerID))groups.set(m.providerID,[]);groups.get(m.providerID).push(m)}
  const favKey=(m)=>`${m.providerID}/${m.id}`
  $('modelChoices').innerHTML=[...groups.entries()].sort((a,b)=>providerName(a[0]).localeCompare(providerName(b[0]))).map(([pid,items])=>`<div class="project">${escapeHtml(providerName(pid))}</div>${items.sort((a,b)=>Number(favorites.has(favKey(b)))-Number(favorites.has(favKey(a)))||(a.name||a.id).localeCompare(b.name||b.id)).map((m)=>`<button class="choice" data-model="${escapeHtml(m.id)}" data-provider="${escapeHtml(m.providerID)}"><div class="choice-title">${favorites.has(favKey(m))?'★ ':''}${escapeHtml(m.name||m.id)}${current?.id===m.id&&current?.providerID===m.providerID?' · ✓':''}</div><div class="choice-meta">${escapeHtml(m.id)} · <span data-fav="${escapeHtml(favKey(m))}">${favorites.has(favKey(m))?'убрать из избранного':'в избранное'}</span></div></button>`).join('')}`).join('')||'<div class="empty">Модели не найдены.</div>'
  document.querySelectorAll('[data-model]').forEach((button)=>button.addEventListener('click',(event)=>{
    const fav=event.target.closest('[data-fav]'); if(fav){event.preventDefault();event.stopPropagation();const key=fav.dataset.fav;favorites.has(key)?favorites.delete(key):favorites.add(key);saveJson(FAV_KEY,[...favorites]);renderModelChoices();return}
    $('modelDialog').close();changeModel({id:button.dataset.model,providerID:button.dataset.provider})
  }))
}

function renderHeader(){
  const s=state.selected; $('headerTitle').textContent=s?sessionTitle(s):'OpenCode'; $('sessionActions').disabled=!s
  $('headerSub').textContent=s?`${projectInfo(s).label} · ${directory(s)}${isRunning(s.id)?' · выполняется':''}`:''
  renderRunControls(); renderUsage(); renderGitButton(); renderNotifyButton()
}
function renderRunControls(){
  const running=!!state.selected&&isRunning(state.selected.id); $('stop').hidden=!running; $('deliveryControls').hidden=!running
  document.querySelectorAll('[data-delivery]').forEach((b)=>b.classList.toggle('active',b.dataset.delivery===state.deliveryMode))
  $('input').placeholder=running?(state.deliveryMode==='queue'?'Сообщение будет отправлено после завершения…':'Steer: скорректировать текущую работу…'):'Сообщение…'
}

function clipped(value,limit=16000){if(value===undefined||value===null)return'';let text;try{text=typeof value==='string'?value:JSON.stringify(value,null,2)}catch{text=String(value)}return text.length>limit?`${text.slice(0,limit)}\n…обрезано…`:text}
function toolName(part){return part.name||part.tool||part.id||'tool'}
function toolStatus(part){return part.state?.status||part.status||'completed'}
function toolInput(part){return part.state?.input??part.input??part.args}
function toolOutput(part){const value=part.state?.content??part.output??part.result;if(Array.isArray(value))return value.map((v)=>v?.type==='text'?v.text:v?.text||v?.name||clipped(v,4000)).join('\n');return value}
function renderTool(part){
  const name=toolName(part), low=name.toLowerCase(), status=toolStatus(part), input=toolInput(part), rawContent=part.state?.content??part.content, output=toolOutput(part), error=part.state?.error||part.error
  let special=''
  const images=Array.isArray(rawContent)?rawContent.map(imagePart).filter(Boolean):[]
  if(/shell|bash|command/.test(low)&&input){const cmd=typeof input==='string'?input:input.command||input.cmd; if(cmd)special=`<div class="tool-section"><div class="tool-label">Команда</div><pre>$ ${escapeHtml(cmd)}</pre></div>`}
  if(/read|write|edit|file/.test(low)&&input&&typeof input==='object'){const path=input.path||input.file||input.filename;if(path)special+=`<div class="tool-section"><div class="tool-label">Файл</div><pre>${escapeHtml(path)}</pre></div>`}
  const genericIn=special?'':clipped(input), genericOut=clipped(output), genericErr=clipped(error?.message||error)
  let renderedOut=''
  if(genericOut&&/diff|patch/.test(low)){const diffHtml=escapeHtml(genericOut).split('\n').map((line)=>`<span class="${line.startsWith('+')&&!line.startsWith('+++')?'diff-add':line.startsWith('-')&&!line.startsWith('---')?'diff-del':''}">${line}</span>`).join('\n');renderedOut=`<div class="tool-section"><div class="tool-label">Diff</div><pre>${diffHtml}</pre></div>`}
  else if(genericOut)renderedOut=`<div class="tool-section"><div class="tool-label">Результат</div><pre>${escapeHtml(genericOut)}</pre></div>`
  const imageHtml=images.map((src)=>`<img class="image-preview" src="${escapeHtml(src)}" alt="tool image">`).join('')
  return `<details class="tool ${escapeHtml(status)}"><summary><span class="tool-summary-line"><span>${escapeHtml(name)}</span>${/running|streaming/.test(status)?'<span class="run-dot"></span>':''}<span class="tool-status">${escapeHtml(status)}</span></span></summary>${special}${genericIn?`<div class="tool-section"><div class="tool-label">Вход</div><pre>${escapeHtml(genericIn)}</pre></div>`:''}${renderedOut}${imageHtml}${genericErr?`<div class="tool-section"><div class="tool-label">Ошибка</div><pre>${escapeHtml(genericErr)}</pre></div>`:''}</details>`
}
function imagePart(part){const mime=part.mime||part.mimeType||part.type==='image'&&'image/*';const uri=part.uri||part.url||part.data;return mime?.startsWith?.('image/')||String(uri||'').startsWith('data:image/')?uri:null}
function assistantBody(message){
  const parts=message.content||message.parts||[]; const reasoning=[],tools=[],texts=[],images=[]
  for(const part of parts){if(part.type==='reasoning'&&part.text)reasoning.push(part.text);else if(part.type==='tool')tools.push(part);else if(part.type==='text'&&part.text)texts.push(part.text);else{const img=imagePart(part);if(img)images.push(img)}}
  if(!parts.length&&message.text)texts.push(message.text)
  const trace=(reasoning.length||tools.length)?`<details class="trace"><summary>Ход выполнения${tools.length?` · инструментов ${tools.length}`:''}</summary><div class="trace-content">${reasoning.map((r)=>`<div class="reasoning">${escapeHtml(r)}</div>`).join('')}${tools.map(renderTool).join('')}</div></details>`:''
  return `${trace}${texts.map((text)=>`<div class="markdown">${renderMarkdown(text)}</div>`).join('')}${images.map((src)=>`<img class="image-preview" src="${escapeHtml(src)}" alt="image">`).join('')}${message.error?`<div class="markdown">${renderMarkdown(`**Ошибка:** ${message.error.message||message.error}`)}</div>`:''}`
}
function userBody(message){const files=(message.files||[]).map((f)=>`<span class="file-chip">${escapeHtml(f.name||f.mime||'файл')}</span>`).join('');return `<div class="markdown">${renderMarkdown(message.text||'')}</div>${files?`<div>${files}</div>`:''}`}
function messagePlainText(message){
  if((message.type||message.role)==='user')return message.text||''
  const parts=message.content||message.parts||[];return parts.filter((p)=>p.type==='text').map((p)=>p.text||'').join('\n')||message.text||''
}
function renderMessages(){
  const inner=$('messagesInner'), view=$('messages'); if(!state.selected){inner.innerHTML='<div class="welcome">Выбери сессию или задай быстрый вопрос.</div>';return} if(!state.context.length){inner.innerHTML='<div class="welcome">Пока нет сообщений.</div>';return}
  const stick=view.scrollHeight-view.scrollTop-view.clientHeight<100; const prev=view.scrollTop
  inner.innerHTML=state.context.map((message,index)=>{const type=message.type||message.role;const id=message.id||message.messageID||`idx-${index}`;const body=type==='user'?userBody(message):assistantBody(message);return `<article class="message ${type==='user'?'user':'assistant'}" data-message-index="${index}"><div class="avatar">${type==='user'?'Я':'AI'}</div><div class="message-body"><div class="message-head"><span class="message-role">${type==='user'?'Ты':'OpenCode'}</span><span class="message-actions"><button class="mini" data-copy-message="${index}">Copy</button><button class="mini" data-fork-message="${escapeHtml(id)}">Fork</button></span></div>${body}</div></article>`}).join('')
  if(stick)view.scrollTop=view.scrollHeight;else view.scrollTop=prev
}

function usageForMessage(message){
  const source=message.usage||message.tokens||message.info?.usage||message.info?.tokens||{}
  const num=(...keys)=>{for(const key of keys){const v=source?.[key]??message?.[key]??message.info?.[key];if(Number.isFinite(v))return Number(v)}return 0}
  const input=num('input','inputTokens','prompt','promptTokens'), output=num('output','outputTokens','completion','completionTokens'), cacheRead=num('cacheRead','cache_read','cacheReadTokens'), cacheWrite=num('cacheWrite','cache_write','cacheWriteTokens')
  const costValue=source.cost??message.cost??message.info?.cost; const cost=typeof costValue==='number'?costValue:typeof costValue==='object'?Object.values(costValue).filter(Number.isFinite).reduce((a,b)=>a+b,0):0
  return {input,output,cacheRead,cacheWrite,cost}
}
function usageSummary(){
  let input=0,output=0,cacheRead=0,cacheWrite=0,cost=0,lastInput=0,hasUsage=false
  for(const message of state.context){const u=usageForMessage(message);if(u.input||u.output||u.cacheRead||u.cacheWrite||u.cost)hasUsage=true;input+=u.input;output+=u.output;cacheRead+=u.cacheRead;cacheWrite+=u.cacheWrite;cost+=u.cost;if((message.type||message.role)==='assistant'&&u.input)lastInput=u.input}
  const approx=Math.ceil(state.context.reduce((sum,m)=>sum+messagePlainText(m).length,0)/4); const model=activeModel();const limit=Number(model?.limit?.context||model?.limits?.context||model?.context||0);const current=lastInput||approx;return{input,output,cacheRead,cacheWrite,cost,current,limit,approx:!hasUsage}
}
function fmtTokens(n){if(!n)return'0';if(n>=1e6)return`${(n/1e6).toFixed(1)}M`;if(n>=1e3)return`${(n/1e3).toFixed(1)}k`;return String(Math.round(n))}
function renderUsage(){
  const u=usageSummary(), pct=u.limit?Math.min(100,Math.round(u.current/u.limit*100)):0, q=latestQuota(); $('usageButton').textContent=u.limit?`Ctx ${pct}%`:`Ctx ${fmtTokens(u.current)}`
  const quota=q?.state==='ok'?'OK':q?.state==='exhausted'?`исчерпан → ${q.resetAt||'?'}`:'нет данных'
  $('usageDetails').innerHTML=`<div class="usage-grid"><span>Текущий контекст${u.approx?' (оценка)':''}</span><strong>${fmtTokens(u.current)}${u.limit?` / ${fmtTokens(u.limit)}`:''}</strong><span>Input за сессию</span><span>${fmtTokens(u.input)}</span><span>Output за сессию</span><span>${fmtTokens(u.output)}</span><span>Cache read/write</span><span>${fmtTokens(u.cacheRead)} / ${fmtTokens(u.cacheWrite)}</span><span>Стоимость</span><span>${u.cost?`$${u.cost.toFixed(4)}`:'—'}</span><span>Qwen probe</span><span>${escapeHtml(quota)}</span><span>Personal Pro caps</span><span>${PERSONAL_PRO_LIMITS.fiveHour.toLocaleString()} / 5h · ${PERSONAL_PRO_LIMITS.sevenDay.toLocaleString()} / 7d</span></div>${u.limit?`<div class="usage-bar"><div style="width:${pct}%"></div></div>`:''}<p class="choice-meta">Лимиты плана показываются как caps; текущий расход Alibaba API публичным probe не возвращает.</p>`
}

async function refreshGit(){
  clearTimeout(gitTimer); if(!state.selected){state.git={vcs:null,files:[],diffs:[]};renderGitButton();return}
  const id=state.selected.id, dir=directory(state.selected); if(!dir)return
  const [vcs,files]=await Promise.all([api.getVcs(dir),api.getFileStatus(dir)]); if(state.selected?.id!==id)return;state.git={vcs,files,diffs:[]};renderGitButton()
}
function gitBranch(){const v=state.git.vcs;return typeof v==='string'?v:v?.branch||v?.name||v?.ref||''}
function renderGitButton(){const branch=gitBranch(),count=state.git.files.length;$('gitButton').disabled=!state.selected;$('gitButton').textContent=state.selected?`${branch||'Git'}${count?` · ${count}`:''}`:'Git —'}
async function openGitDialog(){
  if(!state.selected)return; $('gitDialog').showModal(); $('gitSummary').textContent='Загрузка…'; const id=state.selected.id
  let diffs=await api.getSessionDiff(id); if(state.selected?.id!==id)return;if(!Array.isArray(diffs)||!diffs.length)diffs=await api.getVcsDiff(directory(state.selected));if(state.selected?.id!==id)return;state.git.diffs=Array.isArray(diffs)?diffs:[];renderGitDialog()
}
function renderGitDialog(){
  const branch=gitBranch();$('gitSummary').innerHTML=`<span>Ветка: <strong>${escapeHtml(branch||'—')}</strong></span><span>Изменённых файлов: <strong>${state.git.files.length}</strong></span><span>Session diff: <strong>${state.git.diffs.length}</strong></span>`
  $('gitFiles').innerHTML=state.git.files.map((file,index)=>{const path=file.path||file.file||file.name||String(file);const status=file.status||file.type||file.state||'M';return `<button class="file-row" data-file-index="${index}"><span class="file-status">${escapeHtml(status)}</span><span class="path">${escapeHtml(path)}</span></button>`}).join('')||'<div class="empty">Working tree clean или status недоступен.</div>'
  $('gitDiff').innerHTML=state.git.diffs.map((diff)=>{const path=diff.file||diff.path||diff.name||'diff';let text=diff.patch||diff.diff;if(!text&&('before'in diff||'after'in diff))text=`--- before\n${diff.before||''}\n+++ after\n${diff.after||''}`;if(!text)text=clipped(diff,12000);const html=escapeHtml(text).split('\n').map((line)=>`<span class="${line.startsWith('+')&&!line.startsWith('+++')?'diff-add':line.startsWith('-')&&!line.startsWith('---')?'diff-del':''}">${line}</span>`).join('\n');return `<div class="code-block"><div class="code-head">${escapeHtml(path)}</div><pre>${html}</pre></div>`}).join('')
  document.querySelectorAll('[data-file-index]').forEach((b)=>b.addEventListener('click',()=>openFileByIndex(Number(b.dataset.fileIndex))))
}
async function openFileByIndex(index){const file=state.git.files[index];if(!file||!state.selected)return;const path=file.path||file.file||file.name;if(!path)return;try{const value=await api.getFileContent(directory(state.selected),path);$('fileTitle').textContent=path;$('fileContent').textContent=typeof value==='string'?value:value?.content||JSON.stringify(value,null,2);$('fileDialog').showModal()}catch(e){toast(`Файл: ${e.message}`)}}

function renderAttachments(){$('attachments').hidden=!state.attachments.length;$('attachments').innerHTML=state.attachments.map((f,i)=>`<span class="attachment"><span>${escapeHtml(f.name)}</span><button data-remove-attachment="${i}">×</button></span>`).join('');document.querySelectorAll('[data-remove-attachment]').forEach((b)=>b.addEventListener('click',()=>{state.attachments.splice(Number(b.dataset.removeAttachment),1);renderAttachments()}))}
function readFile(file){return new Promise((resolve,reject)=>{const r=new FileReader();r.onload=()=>resolve({uri:r.result,name:file.name||`file-${Date.now()}`,mime:file.type});r.onerror=()=>reject(r.error);r.readAsDataURL(file)})}
async function addFiles(files){try{state.attachments.push(...await Promise.all([...files].map(readFile)));renderAttachments()}catch(e){toast(`Файл: ${e.message}`)}}

async function ensureQuickSession(){if(state.selected)return state.selected;const session=await createAt(state.clientConfig.scratchDirectory);return session}
async function createAt(dir,title){const session=await api.createSession({directory:dir,title,agent:state.draftAgent,model:state.draftModel});state.sessions=[session,...state.sessions.filter((s)=>s.id!==session.id)];await selectSession(session.id);return session}
async function sendMessage(event){
  event?.preventDefault(); const text=$('input').value.trim();if(!text&&!state.attachments.length)return
  try {
    const session=await ensureQuickSession(); const files=state.attachments.map(({uri,name,mime})=>({uri,name,mime})); const running=isRunning(session.id)
    if(running&&state.deliveryMode==='queue'){
      queueFor(session.id).push({text,files});$('input').value='';state.attachments=[];drafts[draftKey()]='';saveJson(DRAFT_KEY,drafts);renderAttachments();autosizeInput();renderSessions();toast('Добавлено в очередь');return
    }
    $('input').value='';state.attachments=[];drafts[draftKey()]='';saveJson(DRAFT_KEY,drafts);renderAttachments();autosizeInput()
    state.running.set(session.id,{status:running?'steer':'running',since:Date.now()});renderHeader();renderSessions();updateBadge()
    await api.sendPrompt(session,{text,files,delivery:running?'steer':'normal'});setTimeout(()=>loadContext(),180)
  } catch(error){toast(`Отправка: ${error.message}`); if(text&&!$('input').value)$('input').value=text;autosizeInput()}
}
async function flushQueue(sessionID){const queue=queueFor(sessionID);if(!queue.length||isRunning(sessionID))return;const session=state.sessions.find((s)=>s.id===sessionID);if(!session)return;const next=queue.shift();state.running.set(sessionID,{status:'queued-start',since:Date.now()});renderSessions();updateBadge();try{await api.sendPrompt(session,{...next,delivery:'normal'})}catch(e){state.running.delete(sessionID);queue.unshift(next);notifyUser('OpenCode: очередь остановлена',e.message,`queue-${sessionID}`)}renderSessions()}
async function stopSelected(){if(!state.selected)return;try{await api.abortSession(state.selected.id);toast('Остановка отправлена')}catch(e){toast(`Остановка: ${e.message}`)}}

function openProjectDialog(mode='create'){state.projectDialogMode=mode;$('projectDialogTitle').textContent=mode==='handoff'?'Продолжить в проекте':'Создать в проекте';const projects=state.projects.filter((p)=>p.id!==QUICK_PROJECT_ID);$('projectChoices').innerHTML=projects.map((p)=>`<button class="choice" data-project="${escapeHtml(p.id)}"><div class="choice-title">${escapeHtml(projectLabel(p))}</div><div class="choice-meta">${escapeHtml(p.canonical||p.id)}</div></button>`).join('')||'<div class="empty">Проекты не найдены.</div>';document.querySelectorAll('[data-project]').forEach((b)=>b.addEventListener('click',()=>chooseProject(b.dataset.project)));$('projectDialog').showModal()}
async function chooseProject(projectID){const project=state.projects.find((p)=>p.id===projectID);if(!project)return;$('projectDialog').close();if(state.projectDialogMode==='handoff')await continueInProject(project);else try{await createAt(project.canonical,'Новая сессия')}catch(e){toast(`Создание: ${e.message}`)}}
function handoffText(sourceSession,sourceContext){const rows=sourceContext.slice(-40).map((m)=>`${(m.type||m.role)==='user'?'USER':'ASSISTANT'}:\n${messagePlainText(m)}`).join('\n\n');const clippedRows=rows.length>24000?rows.slice(-24000):rows;return `Продолжи работу из предыдущей OpenCode-сессии. Это перенос контекста, а не новая независимая задача.\n\nИсходная сессия: ${sourceSession?.id}\nИсходная директория: ${directory(sourceSession)}\n\nПоследний контекст:\n${clippedRows}`}
async function continueInProject(project){if(!state.selected)return;try{const old=state.selected,oldContext=[...state.context],handoff=handoffText(old,oldContext);const session=await api.createSession({directory:project.canonical,title:`${sessionTitle(old)} → ${projectLabel(project)}`,agent:old.agent||state.draftAgent,model:old.model||state.draftModel});state.sessions=[session,...state.sessions];await selectSession(session.id);state.running.set(session.id,{status:'handoff',since:Date.now()});await api.sendPrompt(session,{text:handoff,files:[],delivery:'normal'});renderSessions();renderHeader()}catch(e){toast(`Перенос: ${e.message}`)}}

async function forkWithFallback(session,messageID){
  try { return await api.forkSession(session.id,messageID) }
  catch(error){
    if(error.status!==404&&error.status!==405)throw error
    const sourceContext=state.context
    let end=sourceContext.length
    if(messageID){const idx=sourceContext.findIndex((m)=>m.id===messageID||m.messageID===messageID);if(idx>=0)end=idx+1}
    const context=sourceContext.slice(0,end)
    const created=await api.createSession({directory:directory(session),title:`${sessionTitle(session)} · fork`,agent:session.agent||state.draftAgent,model:session.model||state.draftModel})
    const handoff=handoffText(session,context)
    state.running.set(created.id,{status:'fork-handoff',since:Date.now()})
    await api.sendPrompt(created,{text:handoff,files:[],delivery:'normal'})
    return created
  }
}

function openSessionActions(id=state.selected?.id){const session=state.sessions.find((s)=>s.id===id);if(!session)return;state.actionSession=session;const m=meta(session.id);$('sessionActionList').innerHTML=`<button class="action" data-action="rename">Переименовать</button><button class="action" data-action="pin">${m.pinned?'Открепить':'Закрепить'}</button><button class="action" data-action="archive">${m.archived?'Вернуть из архива':'Архивировать'}</button><button class="action" data-action="duplicate">Дублировать (Fork)</button><button class="action" data-action="fork-last">Fork от последнего сообщения</button><button class="action" data-action="handoff">Продолжить в проекте…</button><button class="action" data-action="delete">Удалить</button>`;document.querySelectorAll('[data-action]').forEach((b)=>b.addEventListener('click',()=>runSessionAction(b.dataset.action)));$('sessionDialog').showModal()}
async function runSessionAction(action){const session=state.actionSession;if(!session)return;$('sessionDialog').close();if(action==='rename'){state.actionSession=session;$('renameInput').value=sessionTitle(session);$('renameDialog').showModal();$('renameInput').focus();return}if(action==='pin'){meta(session.id).pinned=!meta(session.id).pinned;saveMeta();renderSessions();return}if(action==='archive'){meta(session.id).archived=!meta(session.id).archived;saveMeta();renderSessions();return}if(action==='handoff'){if(state.selected?.id!==session.id)await selectSession(session.id);openProjectDialog('handoff');return}if(action==='duplicate'||action==='fork-last'){try{if(state.selected?.id!==session.id)await selectSession(session.id);const mid=action==='fork-last'?(state.context.at(-1)?.id||state.context.at(-1)?.messageID):undefined;const fork=await forkWithFallback(session,mid);state.sessions=[fork,...state.sessions.filter((s)=>s.id!==fork.id)];await selectSession(fork.id);toast('Fork создан')}catch(e){toast(`Fork: ${e.message}`)}return}if(action==='delete'){if(await confirmAction('Удалить сессию?',`«${sessionTitle(session)}» будет удалена без возможности восстановления.`))await removeSession(session)}}
async function removeSession(session){try{await api.deleteSession(session.id);state.sessions=state.sessions.filter((s)=>s.id!==session.id);delete sessionMeta[session.id];delete drafts[session.id];saveMeta();saveJson(DRAFT_KEY,drafts);state.running.delete(session.id);state.queues.delete(session.id);if(state.selected?.id===session.id)clearSelection();else renderSessions();toast('Сессия удалена')}catch(e){toast(`Удаление: ${e.message}`)}}
async function renameCurrent(){const session=state.actionSession||state.selected;if(!session)return;const title=$('renameInput').value.trim();if(!title)return;try{const updated=await api.renameSession(session.id,title);session.title=updated?.title||title;$('renameDialog').close();renderSessions();renderHeader()}catch(e){toast(`Rename: ${e.message}`)}}
async function forkAtMessage(messageID){if(!state.selected)return;try{const fork=await forkWithFallback(state.selected,messageID.startsWith('idx-')?undefined:messageID);state.sessions=[fork,...state.sessions.filter((s)=>s.id!==fork.id)];await selectSession(fork.id);toast('Fork создан')}catch(e){toast(`Fork: ${e.message}`)}}

function confirmAction(title,text){return new Promise((resolve)=>{const d=$('confirmDialog');$('confirmTitle').textContent=title;$('confirmText').textContent=text;const cleanup=(value)=>{d.close();$('confirmOk').onclick=null;$('confirmCancel').onclick=null;resolve(value)};$('confirmOk').onclick=()=>cleanup(true);$('confirmCancel').onclick=()=>cleanup(false);d.showModal()})}

function actionLabel(action){return({shell:'Команда',bash:'Команда',edit:'Изменение файла',write:'Запись файла',read:'Чтение файла',glob:'Поиск файлов',grep:'Поиск по содержимому',list:'Список файлов',subagent:'Субагент',task:'Подзадача',webfetch:'Интернет',external_directory:'Внешняя директория'}[action]||action||'Разрешение')}
async function refreshPermissions(){if(!state.selected){hidePermission();return}const requests=await api.getPermissions(directory(state.selected));const pending=requests.find((r)=>r.sessionID===state.selected.id)||null;if(pending)showPermission(pending);else hidePermission()}
function showPermission(p){const changed=state.pendingPermission?.id!==p.id;state.pendingPermission=p;$('permissionBanner').hidden=false;$('permissionTitle').textContent=actionLabel(p.action);$('permissionDetail').textContent=(p.resources||[]).join(', ')||p.action||'';if(changed)notifyUser('OpenCode просит разрешение',`${actionLabel(p.action)} ${(p.resources||[]).join(', ')}`,`perm-${p.id}`)}
function hidePermission(){state.pendingPermission=null;$('permissionBanner').hidden=true}
async function replyPendingPermission(reply){const p=state.pendingPermission;if(!p)return;try{await api.replyPermission(p.sessionID,p.id,reply);hidePermission();toast(reply==='reject'?'Отклонено':'Разрешено');setTimeout(refreshPermissions,250)}catch(e){toast(`Permission: ${e.message}`)}}

async function initNotifications(){renderNotifyButton();if('serviceWorker'in navigator){try{await navigator.serviceWorker.register('/sw.js')}catch(e){console.warn('SW registration failed',e)}}}
function renderNotifyButton(){$('notifyButton').textContent=state.notifyEnabled?'◆':'◇';$('notifyButton').title=state.notifyEnabled?'Уведомления включены':'Уведомления выключены'}
async function toggleNotifications(){if(!('Notification'in window)){toast('Notifications API недоступен');return}if(!state.notifyEnabled){const permission=await Notification.requestPermission();if(permission!=='granted'){toast('Разрешение на уведомления не выдано');return}state.notifyEnabled=true;localStorage.setItem(NOTIFY_KEY,'1');notifyUser('OpenCode','Уведомления включены','notify-enabled')}else{state.notifyEnabled=false;localStorage.setItem(NOTIFY_KEY,'0')}renderNotifyButton()}
async function notifyUser(title,body,tag,sessionID){if(!state.notifyEnabled||!('Notification'in window)||Notification.permission!=='granted')return;const data=sessionID?{url:`/#/session/${encodeURIComponent(sessionID)}`}:{url:'/'};try{const reg=await navigator.serviceWorker?.ready;if(reg?.showNotification)await reg.showNotification(title,{body,tag,data});else new Notification(title,{body,tag,data})}catch{try{new Notification(title,{body,tag,data})}catch{}}}
function updateBadge(){const count=state.running.size;try{if(count)navigator.setAppBadge?.(count);else navigator.clearAppBadge?.()}catch{}}

function ensureAssistant(id){let m=state.context.find((x)=>x.id===id);if(m)return m;m={id,type:'assistant',content:[],time:{created:Date.now()}};state.context.push(m);return m}
function ensurePart(message,type,ordinal=0){let p=(message.content||[]).filter((x)=>x.type===type)[ordinal];if(p)return p;p={type,text:''};message.content||=[];message.content.push(p);return p}
function ensureTool(message,data){let p=(message.content||[]).find((x)=>x.type==='tool'&&x.id===data.id);if(p)return p;p={type:'tool',id:data.id,name:data.name||'tool',state:{status:'streaming',input:''},time:{created:Date.now()}};message.content||=[];message.content.push(p);return p}
function markStarted(sessionID,label='running'){if(!sessionID||(state.sessions.length&&!state.sessions.some((session)=>session.id===sessionID)))return;state.running.set(sessionID,{status:label,since:Date.now()});renderSessions();if(state.selected?.id===sessionID)renderHeader();updateBadge()}
function markFinished(sessionID,kind='готово'){if(!sessionID)return;const wasRunning=state.running.has(sessionID);state.running.delete(sessionID);renderSessions();if(state.selected?.id===sessionID)renderHeader();updateBadge();const session=state.sessions.find((s)=>s.id===sessionID);if(wasRunning&&(document.hidden||state.selected?.id!==sessionID))notifyUser(`OpenCode: ${kind}`,sessionTitle(session),`done-${sessionID}`,sessionID);if(wasRunning||queueFor(sessionID).length)setTimeout(()=>flushQueue(sessionID),80)}
function handleEvent(payload){
  const data=payload.data||payload.properties||{}, sid=data.sessionID||data.session?.id
  if(['session.execution.started','session.busy','session.status.running'].includes(payload.type))markStarted(sid,payload.type)
  if(payload.type==='session.status'){const type=data.status?.type||data.type;if(['busy','retry','running'].includes(type))markStarted(sid,type);if(type==='idle')markFinished(sid,'готово')}
  if(['session.execution.succeeded','session.idle'].includes(payload.type))markFinished(sid,'готово')
  if(['message.part.delta','message.part.updated','message.updated'].includes(payload.type)&&sid===state.selected?.id)scheduleContextReload(140)
  if(payload.type==='session.execution.failed')markFinished(sid,'ошибка')
  if(payload.type==='session.execution.interrupted')markFinished(sid,'остановлено')
  if(payload.type==='permission.asked'){if(data.sessionID===state.selected?.id)showPermission(data);else notifyUser('OpenCode просит разрешение',actionLabel(data.action),`perm-${data.id}`)}
  if(!state.selected||sid!==state.selected.id)return
  let message,part
  switch(payload.type){
    case'session.step.started':ensureAssistant(data.assistantMessageID);renderMessages();break
    case'session.reasoning.started':ensurePart(ensureAssistant(data.assistantMessageID),'reasoning',data.ordinal||0);renderMessages();break
    case'session.reasoning.delta':part=ensurePart(ensureAssistant(data.assistantMessageID),'reasoning',data.ordinal||0);part.text+=(data.delta||'');renderMessages();break
    case'session.reasoning.ended':part=ensurePart(ensureAssistant(data.assistantMessageID),'reasoning',data.ordinal||0);part.text=data.text||part.text;renderMessages();break
    case'session.text.started':ensurePart(ensureAssistant(data.assistantMessageID),'text',data.ordinal||0);renderMessages();break
    case'session.text.delta':part=ensurePart(ensureAssistant(data.assistantMessageID),'text',data.ordinal||0);part.text+=(data.delta||'');renderMessages();break
    case'session.text.ended':part=ensurePart(ensureAssistant(data.assistantMessageID),'text',data.ordinal||0);part.text=data.text||part.text;renderMessages();break
    case'session.tool.input.started':ensureTool(ensureAssistant(data.assistantMessageID),data);renderMessages();break
    case'session.tool.input.delta':part=ensureTool(ensureAssistant(data.assistantMessageID),data);part.state.input+=(data.delta||'');renderMessages();break
    case'session.tool.called':part=ensureTool(ensureAssistant(data.assistantMessageID),data);part.state={status:'running',input:data.input||{},metadata:{}};renderMessages();break
    case'session.tool.progress':part=ensureTool(ensureAssistant(data.assistantMessageID),data);part.state.metadata=data.metadata||{};renderMessages();break
    case'session.tool.success':part=ensureTool(ensureAssistant(data.assistantMessageID),data);part.state={status:'completed',input:part.state.input||data.input||{},content:data.content||[],metadata:data.metadata||{}};renderMessages();break
    case'session.tool.failed':part=ensureTool(ensureAssistant(data.assistantMessageID),data);part.state={status:'error',input:part.state.input||{},error:data.error,content:data.content||[]};renderMessages();break
    case'session.inbox.delivered':case'session.execution.succeeded':case'session.execution.failed':case'session.execution.interrupted':scheduleContextReload(120);break
    default: if(payload.type.startsWith('session.'))scheduleContextReload(450)
  }
}
function connectEventStream(){eventSource?.close();eventSource=api.connectEvents(handleEvent,()=>{if(state.running.size)toast('Переподключение к event stream…',1200)})}
async function pollStatuses(){const statuses=await api.sessionStatuses();let changed=false;for(const session of state.sessions){const running=runningStatus(statuses?.[session.id]);if(running&&!isRunning(session.id)){state.running.set(session.id,{status:normalizeRunStatus(statuses[session.id]),since:Date.now()});changed=true}else if(!running&&isRunning(session.id)&&statuses&&session.id in statuses){markFinished(session.id,'готово');changed=true}}if(changed){renderSessions();renderHeader();updateBadge()}}

function setupPullRefresh(){const el=$('messages');let start=null;el.addEventListener('touchstart',(e)=>{if(el.scrollTop<=2)start=e.touches[0].clientY},{passive:true});el.addEventListener('touchend',(e)=>{if(start===null)return;const dy=e.changedTouches[0].clientY-start;start=null;if(dy>90){toast('Обновление…',900);loadSessions();if(state.selected)loadContext()}},{passive:true})}
function autosizeInput(){const el=$('input');el.style.height='auto';el.style.height=Math.min(el.scrollHeight,180)+'px'}

function bindEvents(){
  $('newSession').addEventListener('click',async()=>{clearSelection();try{await createAt(state.clientConfig.scratchDirectory)}catch(e){toast(`Создание: ${e.message}`)}})
  $('chooseProject').addEventListener('click',()=>openProjectDialog('create'));$('refresh').addEventListener('click',()=>{loadSessions();if(state.selected)loadContext()});$('search').addEventListener('input',renderSessions);$('showArchived').addEventListener('change',renderSessions)
  $('menu').addEventListener('click',()=> $('sidebar').classList.toggle('open'));$('sessionActions').addEventListener('click',()=>openSessionActions());$('modelButton').addEventListener('click',()=>{renderModelChoices();$('modelDialog').showModal();$('modelSearch').focus()});$('modelSearch').addEventListener('input',renderModelChoices)
  $('variantSelect').addEventListener('change',(e)=>{const ref=activeModelRef();if(!ref)return;const model={id:ref.id,providerID:ref.providerID};if(e.target.value)model.variant=e.target.value;changeModel(model)})
  $('form').addEventListener('submit',sendMessage);$('stop').addEventListener('click',stopSelected);$('input').addEventListener('input',()=>{autosizeInput();scheduleDraftSave()});$('input').addEventListener('keydown',(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();$('form').requestSubmit()}})
  $('attachButton').addEventListener('click',()=> $('fileInput').click());$('fileInput').addEventListener('change',(e)=>{addFiles(e.target.files);e.target.value=''});$('input').addEventListener('paste',(e)=>{const files=[...(e.clipboardData?.items||[])].filter((i)=>i.kind==='file').map((i)=>i.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();addFiles(files)}})
  document.querySelectorAll('[data-delivery]').forEach((b)=>b.addEventListener('click',()=>{state.deliveryMode=b.dataset.delivery;renderRunControls()}));$('gitButton').addEventListener('click',openGitDialog);$('usageButton').addEventListener('click',()=>{$('usageDialog').showModal()});$('notifyButton').addEventListener('click',toggleNotifications)
  $('renameForm').addEventListener('submit',(e)=>{e.preventDefault();renameCurrent()});document.querySelectorAll('[data-close]').forEach((b)=>b.addEventListener('click',()=>$(b.dataset.close).close()));document.querySelectorAll('dialog').forEach((d)=>d.addEventListener('click',(e)=>{if(e.target===d)d.close()}))
  document.querySelectorAll('[data-permission]').forEach((b)=>b.addEventListener('click',()=>replyPendingPermission(b.dataset.permission)))
  $('messagesInner').addEventListener('click',(e)=>{const copyCode=e.target.closest('.copy-code');if(copyCode){navigator.clipboard.writeText(copyCode.closest('.code-block').querySelector('code')?.textContent||'');copyCode.textContent='Скопировано';setTimeout(()=>copyCode.textContent='Копировать',900);return}const copy=e.target.closest('[data-copy-message]');if(copy){navigator.clipboard.writeText(messagePlainText(state.context[Number(copy.dataset.copyMessage)])||'');toast('Сообщение скопировано');return}const fork=e.target.closest('[data-fork-message]');if(fork){forkAtMessage(fork.dataset.forkMessage)}})
  window.addEventListener('hashchange',()=>{const id=sessionIdFromHash();if(id&&state.selected?.id!==id)selectSession(id,{push:false});else if(!id&&state.selected)clearSelection()});window.addEventListener('beforeunload',saveDraftNow)
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){pollStatuses();if(state.selected){loadContext();refreshPermissions()}}})
}

async function initialize(){
  state.clientConfig=await api.getClientConfig();bindEvents();setupPullRefresh();await initNotifications();connectEventStream();await loadSessions({selectHash:true});if(!state.selected){restoreDraft();await loadDraftControls()}permissionTimer=setInterval(refreshPermissions,1800);statusTimer=setInterval(pollStatuses,5000);setInterval(()=>{if(!state.loading)loadSessions()},30000);autosizeInput();renderHeader()
}
initialize().catch((error)=>{console.error(error);toast(`Ошибка запуска: ${error.message}`,7000)})
