import * as api from './api.js'
import { escapeHtml, renderMarkdown } from './markdown.js'
import { modeFromAgent, ORCHESTRATED_MODELS } from './ux-state.js'
import { createAdaptivePoller, createRefreshCoalescer } from './refresh-coalescer.js'

const $ = (id) => document.getElementById(id)
const QUICK_PROJECT_ID = '__custom_opencode_quick__'
const META_KEY = 'opencode:web:session-meta-v2'
const DRAFT_KEY = 'opencode:web:drafts-v2'
const FAV_KEY = 'opencode:web:favorites'
const PROJECT_COLLAPSE_KEY = 'opencode:web:project-collapse-v1'
const PROJECT_ORDER_KEY = 'opencode:web:project-order-v1'
const SESSION_TREE_KEY = 'opencode:web:session-tree-v1'
const NOTIFY_KEY = 'opencode:web:notifications'
const LAST_MODEL_KEY = 'opencode:web:last-model-v1'
const PERSONAL_PRO_LIMITS = { fiveHour: 12000, sevenDay: 40000 }
const CONTEXT_PAGE_SIZE = 80
const QWEN_SUFFIX_RE = /\s·\sQwen\s+(OK|exhausted→([^·]+))\s*$/
const PERMISSION_SUPPRESSION_TTL = 15_000

const permissionSuppression = window.__permissionSuppression ||= (() => {
  const resolved = new Map()
  const prune = (now = Date.now()) => {
    for (const [key, expiresAt] of resolved) if (expiresAt <= now) resolved.delete(key)
  }
  return {
    resolved,
    prune,
    isResolved(key) { prune(); return Boolean(key && resolved.has(key)) },
    markResolved(key) { if (key) resolved.set(key, Date.now() + PERMISSION_SUPPRESSION_TTL) },
    forget(key) { if (key) resolved.delete(key) },
  }
})()
window.__resolvedPermissions = permissionSuppression.resolved

const state = {
  clientConfig: null,
  sessions: [], projects: [], selected: null, context: [],
  contextCache: new Map(),
  mirrorHistory: new Map(),
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
let gitTimer = null
let eventSource = null
let dragPayload = null
let dragHandlersInstalled = false
let promptHistory = { sessionID:null, entries:[], cursor:0, draft:'', value:'' }
let applyingPromptHistory = false
let initialMessageScrollSession = null
let initialMessageScrollObserver = null
let historyPaginationIntent = false
let historyPaginationIntentTimer = 0
let historyPaginationTouch = null
let statusSyncGeneration = 0
let sessionSyncGeneration = 0
let rateLimitSyncGeneration = 0
let messageRenderFrame = null
const sessionModelVersions = new Map()
const sessionModelOverrides = new Map()
const sessionModelQueues = new Map()

function loadJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key) || '') || fallback } catch { return fallback }
}
function saveJson(key, value) { localStorage.setItem(key, JSON.stringify(value)) }
function meta(id) { return sessionMeta[id] ||= { pinned:false } }
function saveMeta() { saveJson(META_KEY, sessionMeta) }
function draftKey() { return state.selected?.id || '__new__' }
function saveDraftNow() { drafts[draftKey()] = promptHistory.sessionID === state.selected?.id && promptHistory.cursor < promptHistory.entries.length ? promptHistory.draft : $('input').value; saveJson(DRAFT_KEY, drafts) }
function restoreDraft() { $('input').value = drafts[draftKey()] || ''; autosizeInput() }
function scheduleDraftSave() { clearTimeout(draftSaveTimer); draftSaveTimer = setTimeout(saveDraftNow, 180) }
function toast(text, ms = 2600) { const el=$('toast'); el.textContent=text; el.hidden=false; clearTimeout(el._timer); el._timer=setTimeout(()=>el.hidden=true,ms) }
// Last explicitly chosen model for new sessions. Restored after reload so a
// fresh chat does not silently fall back to whatever the backend calls the
// default; existing sessions keep their own stored model untouched.
function saveLastModel(model){ if(!model?.id||!model?.providerID)return; const value={id:model.id,providerID:model.providerID}; if(model.variant)value.variant=model.variant; saveJson(LAST_MODEL_KEY,value) }
function loadLastModel(){ const value=loadJson(LAST_MODEL_KEY,null); return value?.id&&value?.providerID?value:null }

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
function projectOrder() { return loadJson(PROJECT_ORDER_KEY, []) }
function sessionTreeExpanded() { return new Set(loadJson(SESSION_TREE_KEY, [])) }
function orderIndex(order, value) { const index=order.indexOf(value); return index<0?Number.MAX_SAFE_INTEGER:index }
function sessionCreated(session) { return session?.time?.created || 0 }
function compareSessions(a,b) { return Number(meta(b.id).pinned)-Number(meta(a.id).pinned)||sessionTime(b)-sessionTime(a)||sessionCreated(b)-sessionCreated(a)||sessionTitle(a).localeCompare(sessionTitle(b),'ru',{sensitivity:'base',numeric:true})||String(a?.id||'').localeCompare(String(b?.id||'')) }
function clearDragState() { dragPayload=null; document.querySelectorAll('.is-dragging,.drop-target').forEach((element)=>element.classList.remove('is-dragging','drop-target')) }
function setDragData(event,type,value) {
  dragPayload={type,value}
  event.dataTransfer?.setData(`application/x-custom-opencode-${type}`,value)
  event.dataTransfer?.setData('text/plain',`${type}:${value}`)
  if (event.dataTransfer) event.dataTransfer.effectAllowed='move'
}
function dragValue(event,type) {
  if (dragPayload?.type===type) return dragPayload.value
  const value=event.dataTransfer?.getData(`application/x-custom-opencode-${type}`)
  if (value) return value
  const fallback=event.dataTransfer?.getData('text/plain')||''
  return fallback.startsWith(`${type}:`)?fallback.slice(type.length+1):''
}
function attachDragHandlers() {
  if (dragHandlersInstalled) return
  const root=$('sessions')
  if (!root) return
  dragHandlersInstalled=true
  root.addEventListener('dragstart',(event)=>{
    if(event.target.closest?.('[data-session-mirror]')){event.preventDefault();clearDragState();return}
    const session=event.target.closest?.('[data-session-drag]')
    const group=event.target.closest?.('.project-group')
    if (session && group) { setDragData(event,'session',session.dataset.sessionDrag);session.classList.add('is-dragging');return }
    const project=event.target.closest?.('.project')
    if (project && group) { setDragData(event,'project',group.dataset.project);project.classList.add('is-dragging') }
  })
  root.addEventListener('dragend',clearDragState)
  root.addEventListener('dragover',(event)=>{
    const sourceSession=dragValue(event,'session'),sourceProject=dragValue(event,'project')
    if (!sourceSession&&!sourceProject) return
    const targetSession=event.target.closest?.('[data-session-drag]')
    const targetProject=event.target.closest?.('.project-group')
    if (!targetProject || sourceSession && targetSession?.dataset.sessionDrag===sourceSession || sourceProject && targetProject.dataset.project===sourceProject) return
    event.preventDefault()
    if (event.dataTransfer) event.dataTransfer.dropEffect='move'
    document.querySelectorAll('.drop-target').forEach((element)=>element.classList.remove('drop-target'))
    ;(targetSession||targetProject)?.classList.add('drop-target')
  })
  root.addEventListener('dragleave',(event)=>{
    if (!root.contains(event.relatedTarget)) clearDragState()
  })
  root.addEventListener('drop',(event)=>{
    event.preventDefault()
    handleDrop(event).catch((error)=>toast(`Перенос: ${error.message}`))
  })
}
function reorderProjects(sourceProject,targetProject,after=false) {
  const order=[...document.querySelectorAll('#sessions .project-group')].map((group)=>group.dataset.project)
  const sourceIndex=order.indexOf(sourceProject),targetIndex=order.indexOf(targetProject)
  if (sourceIndex<0||targetIndex<0||sourceProject===targetProject)return
  order.splice(sourceIndex,1)
  let insertion=order.indexOf(targetProject)+(after?1:0)
  order.splice(Math.max(0,insertion),0,sourceProject)
  saveJson(PROJECT_ORDER_KEY,order);renderSessions()
}
async function sessionWithControls(session){
  try{
    const detail=await api.getSession(session.id)
    if(!detail||typeof detail!=='object')return session
    const model=session.model||detail.model?{...(session.model||{}),...(detail.model||{})}:undefined
    return {...session,...detail,...(model?{model}:{})}
  }catch{return session}
}
function primaryAgentFor(model, agent) {
  const id = String(agent || 'build')
  if (!['build', 'plan', 'build-direct', 'plan-direct'].includes(id)) return agent
  const modelID = model?.id || model?.modelID
  const providerID = model?.providerID || model?.provider
  const mode = id.startsWith('plan') ? 'plan' : 'build'
  const orchestrated = (providerID === 'bailian-cli' && modelID === 'qwen3.8-orchestrated') || (providerID === 'openai' && modelID === 'gpt-5.6-sol-orchestrated')
  return orchestrated ? mode : `${mode}-direct`
}
async function transferSessionToProject(session,project,{select=false,removeSource=false}={}) {
  if(state.selected?.id===session.id)saveDraftNow()
  const sourceSession=await sessionWithControls(session)
  const context=state.selected?.id===session.id&&state.context.length?[...state.context]:await api.getContext(session.id)
  const created=await api.createSession({directory:project.canonical,title:`${sessionTitle(sourceSession)} → ${projectLabel(project)}`,agent:primaryAgentFor(sourceSession.model,sourceSession.agent),model:sourceSession.model})
  if (!created?.id) throw new Error('OpenCode не вернул id новой сессии')
  state.sessions=[created,...state.sessions.filter((item)=>item.id!==created.id)]
  if(context.length){
    const handoff=handoffText(sourceSession,context)
    state.running.set(created.id,{status:'handoff',since:Date.now()});renderSessions();renderHeader()
    try { await api.sendPrompt(created,{text:handoff,files:[],delivery:'normal'}) }
    catch (error) {
      state.running.delete(created.id);state.sessions=state.sessions.filter((item)=>item.id!==created.id);clearSessionModelState(created.id)
      try{await api.deleteSession(created.id)}catch{}
      renderSessions();renderHeader();throw error
    }
  }
  let sourceRemoved=false
  if(removeSource){
    if(Object.prototype.hasOwnProperty.call(drafts,session.id))drafts[created.id]=drafts[session.id]
    saveJson(DRAFT_KEY,drafts)
    try{
      await api.deleteSession(session.id)
      state.sessions=state.sessions.filter((item)=>item.id!==session.id)
      delete sessionMeta[session.id];delete drafts[session.id];saveMeta();saveJson(DRAFT_KEY,drafts)
      state.running.delete(session.id);state.queues.delete(session.id);clearSessionModelState(session.id);sourceRemoved=true
    }catch{
      toast('Копия создана, но исходную сессию удалить не удалось')
    }
  }
  if(select)await selectSession(created.id,{saveDraft:false})
  renderSessions();renderHeader()
  return {created,sourceRemoved}
}
async function handleDrop(event) {
  const sourceSession=dragValue(event,'session'),sourceProject=dragValue(event,'project')
  const targetSession=event.target.closest?.('[data-session-drag]')
  const targetGroup=event.target.closest?.('.project-group')
  const targetProject=targetGroup?.dataset.project||''
  const targetRect=targetSession?.getBoundingClientRect?.()||targetGroup?.querySelector('.project')?.getBoundingClientRect?.()
  const after=Boolean(targetRect && event.clientY>targetRect.top+targetRect.height/2)
  clearDragState()
  if(sourceProject){if(targetProject)reorderProjects(sourceProject,targetProject,after);return}
  if(!sourceSession||!targetProject)return
  const source=state.sessions.find((session)=>session.id===sourceSession)
  if(!source)return
  const sourceInfo=projectInfo(source)
  if(sourceInfo.key===targetProject)return
  const project=state.projects.find((item)=>item.id===targetProject)
  if(!project||project.id===QUICK_PROJECT_ID)return
  if(!await confirmAction('Перенести через handoff?',`OpenCode не умеет менять папку существующей сессии. В «${projectLabel(project)}» попадут последние 40 текстовых сообщений (до 24 000 символов); файлы проекта и полная tool-история не переносятся. После успешного handoff исходная сессия будет удалена.`))return
  const {created,sourceRemoved}=await transferSessionToProject(source,project,{select:state.selected?.id===source.id,removeSource:true})
  renderSessions()
  toast(sourceRemoved?`Сессия перенесена в проект «${projectLabel(project)}»`:'Создана копия; исходная сессия сохранена')
}
function activeModelRef() { return state.selected?.model || (!state.selected && state.draftModel) || state.defaultModel || null }
function modelRefChanged(a,b) { return a?.id!==b?.id || a?.providerID!==b?.providerID || a?.variant!==b?.variant }
function clearSessionModelState(id) { sessionModelVersions.delete(id);sessionModelOverrides.delete(id);sessionModelQueues.delete(id) }
function hasSession(id) { return state.selected?.id===id||state.sessions.some((session)=>session.id===id) }
function dispatchModelChanged(sessionID,model,previousModel,ok,error) { window.dispatchEvent(new CustomEvent('custom-opencode:model-changed',{detail:{sessionID,model:{...model},previousModel,ok,...(error?{error}:{})}})) }
function setSessionModel(id,model) {
  const next={...model}
  if(state.selected?.id===id)state.selected.model=next
  const index=state.sessions.findIndex((session)=>session.id===id)
  if(index>=0)state.sessions[index]={...state.sessions[index],model:next}
}
function sessionModelFromRead(id,model,versionAtStart,localModel) {
  const override=sessionModelOverrides.get(id)
  if(override){
    if(!modelRefChanged(model,override.model))sessionModelOverrides.delete(id)
    else return {...override.model}
  }
  if(sessionModelVersions.get(id)!==versionAtStart&&localModel)return {...localModel}
  return model
}
function queueSessionModelChange(id,change) {
  const previous=sessionModelQueues.get(id)||Promise.resolve()
  const result=previous.catch(()=>{}).then(change)
  const tail=result.catch(()=>{})
  sessionModelQueues.set(id,tail)
  tail.finally(()=>{if(sessionModelQueues.get(id)===tail)sessionModelQueues.delete(id)})
  return result
}
function activeModel() { const ref=activeModelRef(); return ref && state.models.find((m)=>m.id===ref.id && m.providerID===ref.providerID) }
function providerName(id) { return state.providers.find((p)=>p.id===id)?.name || id }
function isRunning(id) { return state.running.has(id) }
function queueFor(id) { if (!state.queues.has(id)) state.queues.set(id,[]); return state.queues.get(id) }
function normalizeRunStatus(value) {
  const raw = typeof value === 'string' ? value : value?.type || value?.status || value?.state || ''
  return String(raw).toLowerCase()
}
function runningStatus(value) { const s=normalizeRunStatus(value); return /running|busy|retry|working|pending/.test(s) }
function invalidateRunSync() { statusSyncGeneration+=1; rateLimitSyncGeneration+=1 }
function syncRunStatuses(statuses) {
  if(!statuses||typeof statuses!=='object'||Array.isArray(statuses))return false
  let changed=false
  for(const session of state.sessions){
    const active=runningStatus(statuses[session.id]),previous=state.running.get(session.id)
    if(active&&!previous){state.running.set(session.id,{status:normalizeRunStatus(statuses[session.id]),since:Date.now()});changed=true}
    // /active is a full snapshot. Allow a just-submitted prompt to reach the server.
    else if(!active&&previous&&!api.isPromptPending(session.id)&&(session.id in statuses||Date.now()-previous.since>=5000)){markFinished(session.id,'готово');changed=true}
  }
  return changed
}

const loadSessionsCoalesced=createRefreshCoalescer()
function loadSessions(options = {}) {
  const force = options.selectHash || !options.background
  return loadSessionsCoalesced(() => loadSessionsNow(options), force)
}
async function loadSessionsNow({ selectHash = false, background = false } = {}) {
  if (!background && !state.sessions.length) { state.loading = true; renderSessions() }
  const sessionGeneration = ++sessionSyncGeneration
  const statusGeneration = ++statusSyncGeneration
  const modelVersionsAtStart = new Map(sessionModelVersions)
  try {
    const [projects, sessions, statuses] = await Promise.all([api.listProjects(), api.listSessions(), api.sessionStatuses()])
    if (sessionGeneration !== sessionSyncGeneration) return
    state.projects = projects
    const unique = new Map(sessions.map((s)=>[s.id,s]))
    for (const [id,session] of unique) {
      const local=state.sessions.find((item)=>item.id===id)||state.selected?.id===id&&state.selected
      const model=sessionModelFromRead(id,session.model,modelVersionsAtStart.get(id),local?.model)
      if(model!==session.model)unique.set(id,{...session,model})
    }
    for(const id of new Set([...sessionModelVersions.keys(),...sessionModelOverrides.keys()]))if(!unique.has(id)&&state.selected?.id!==id){sessionModelVersions.delete(id);sessionModelOverrides.delete(id)}
    state.sessions = [...unique.values()].sort(compareSessions)
    if (statusGeneration === statusSyncGeneration) syncRunStatuses(statuses)
    if (state.selected) state.selected = state.sessions.find((s)=>s.id===state.selected.id) || state.selected
    state.loading = false; renderSessions(); renderHeader(); if(state.selected&&state.models.length)renderControls(); updateBadge()
    if (selectHash && !state.selected) {
      const id = sessionIdFromHash()
      if (id && state.sessions.some((s)=>s.id===id)) await selectSession(id,{ push:false })
    }
  } catch (error) {
    if (sessionGeneration !== sessionSyncGeneration) return
    state.loading = false
    if (!state.sessions.length) {
      $('sessions').innerHTML = `<div class="empty">Не удалось загрузить сессии.<br>${escapeHtml(error.message)}</div>`
    }
    toast('Ошибка загрузки сессий')
  }
}

function sessionMatches(session,query) {
  if(!query)return true
  const info=projectInfo(session)
  return `${sessionTitle(session)} ${info.label} ${info.directory} ${session.agent||''}`.toLowerCase().includes(query)
}
function sessionTree(sessions=state.sessions) {
  const byID=new Map(sessions.map((session)=>[session.id,session])),children=new Map(),roots=[]
  for(const session of sessions){
    const parentID=session?.parentID||session?.parentSessionID||''
    if(parentID&&byID.has(parentID)){if(!children.has(parentID))children.set(parentID,[]);children.get(parentID).push(session)}
    else roots.push(session)
  }
  roots.sort(compareSessions);for(const rows of children.values())rows.sort(compareSessions)
  return {roots,children}
}
function subtreeMatches(session,children,query) { return sessionMatches(session,query)||(children.get(session.id)||[]).some((child)=>subtreeMatches(child,children,query)) }
function renderSessionNode(session,children,expanded,query='',depth=0) {
  const allChildren=children.get(session.id)||[]
  const ownMatch=sessionMatches(session,query)
  const visibleChildren=query&&!ownMatch?allChildren.filter((child)=>subtreeMatches(child,children,query)):allChildren
  const hasChildren=visibleChildren.length>0,open=hasChildren&&(Boolean(query)||expanded.has(session.id))
  const running=isRunning(session.id),queued=queueFor(session.id).length,m=meta(session.id),agent=String(session.agent||'').trim()
  const childBody=hasChildren?`<details class="session-agent-folder" data-agent-folder="${escapeHtml(session.id)}"${open?' open':''}><summary class="session-agent-folder-summary"><span>Агентские диалоги</span><span class="count">${visibleChildren.length}</span></summary><div class="session-children" data-session-children="${escapeHtml(session.id)}">${visibleChildren.map((child)=>renderSessionNode(child,children,expanded,query,depth+1)).join('')}</div></details>`:''
  return `<div class="session-node${depth?' subagent-node':''}" data-session-node="${escapeHtml(session.id)}" data-session-depth="${depth}"><div class="session ${state.selected?.id===session.id?'active':''} ${m.pinned?'pinned':''}${depth?' subagent':''}"${depth?'':` draggable="true" data-session-drag="${escapeHtml(session.id)}"`}>
    <span class="session-tree-spacer" aria-hidden="true"></span><button class="session-main" data-session="${escapeHtml(session.id)}">
      <div class="session-title">${escapeHtml(sessionTitle(session))}</div>
      <div class="session-meta">${running?'<span class="run-dot"></span>':''}${depth&&agent?`<span class="session-kind">${escapeHtml(agent)}</span>`:''}<span>${running?'Выполняется':timeText(sessionTime(session))}</span>${queued?`<span class="queued">очередь ${queued}</span>`:''}${hasChildren?`<span class="session-child-count">агенты ${visibleChildren.length}</span>`:''}</div>
    </button><button class="session-more" data-session-more="${escapeHtml(session.id)}">•••</button>
  </div>${childBody}</div>`
}
function mirrorHasConversation(session) {
  const id=session.id
  if(Number(session.tokens?.input)>0||Number(session.tokens?.output)>0||contextMessages(state.contextCache.get(id)?.messages||[]).length||state.selected?.id===id&&contextMessages(state.context).length)return true
  const previous=state.mirrorHistory.get(id),updated=sessionTime(session)
  if(!previous||previous.updated!==updated){
    const entry={updated,value:previous?.value??null}
    state.mirrorHistory.set(id,entry)
    void api.hasConversation(id).then(value=>{
      if(state.mirrorHistory.get(id)!==entry||!hasSession(id))return
      entry.value=value
      renderSessions()
    }).catch(()=>{})
  }
  return previous?.value!==false
}
function renderSessionShortcuts(collapsed) {
  const current=state.selected,tree=sessionTree(),activity=new Map()
  const sessions=tree.roots.filter(session=>!session.parentID&&!session.parentSessionID)
  for(const session of sessions){
    const family=[session]
    for(let i=0;i<family.length;i++)family.push(...(tree.children.get(family[i].id)||[]))
    activity.set(session.id,{
      selected:family.some(item=>item.id===current?.id),
      running:family.some(item=>isRunning(item.id)),
      lastOpenedAt:family.reduce((latest,item)=>Math.max(latest,meta(item.id).lastOpenedAt||0),0),
    })
  }
  const recent=[]
  for(const session of sessions.sort((a,b)=>activity.get(b.id).lastOpenedAt-activity.get(a.id).lastOpenedAt||sessionTime(b)-sessionTime(a))){
    if(mirrorHasConversation(session))recent.push(session)
    if(recent.length===10)break
  }
  const groups=[
    ['current','Текущее',sessions.filter(session=>{const info=activity.get(session.id);return (info.selected||info.running)&&mirrorHasConversation(session)}).sort((a,b)=>Number(activity.get(b.id).selected)-Number(activity.get(a.id).selected)||sessionTime(b)-sessionTime(a))],
    ['recent','Последнее',recent],
  ]
  return groups.filter(([,,rows])=>rows.length).map(([id,label,rows])=>`<details class="session-mirror" data-session-mirror="${id}" draggable="false"${collapsed.has(`mirror:${id}`)?'':' open'}><summary class="project" title="Быстрые ссылки на основные диалоги"><span>${label}</span><span class="count">${rows.length}</span></summary><div class="project-sessions">${rows.map(session=>{
    const info=activity.get(session.id),status=isRunning(session.id)?'Выполняется':info.running?'Работают агенты':info.selected?(session.id===current?.id?'Открыт':'Открыт агент'):timeText(sessionTime(session))
    return `<div class="session${info.selected?' active':''}"><span class="session-tree-spacer" aria-hidden="true"></span><button type="button" class="session-main" data-session-shortcut="${escapeHtml(session.id)}"${session.id===current?.id?' aria-current="page"':''} title="${escapeHtml(`${sessionTitle(session)} · ${directory(session)}`)}"><div class="session-title">${escapeHtml(sessionTitle(session))}</div><div class="session-meta">${info.running?'<span class="run-dot"></span>':''}<span>${escapeHtml(projectInfo(session).label)}</span><span>${status}</span></div></button></div>`
  }).join('')}</div></details>`).join('')
}
function renderSessions() {
  const container = $('sessions')
  if (!container) return
  if (state.loading && !state.sessions.length) { container.innerHTML='<div class="loading">Загрузка сессий…</div>'; container._lastHtml=''; return }
  const query=$('search').value.trim().toLowerCase(),tree=sessionTree(),roots=tree.roots.filter((session)=>subtreeMatches(session,tree.children,query))
  const groups=new Map()
  for(const session of roots){const info=projectInfo(session);if(!groups.has(info.key))groups.set(info.key,{info,items:[]});groups.get(info.key).items.push(session)}
  for(const group of groups.values())group.items.sort(compareSessions)
  const savedProjectOrder=projectOrder()
  const orderedGroups=[...groups.values()].sort((a,b)=>orderIndex(savedProjectOrder,a.info.key)-orderIndex(savedProjectOrder,b.info.key)||sessionTime(b.items[0])-sessionTime(a.items[0])||a.info.label.localeCompare(b.info.label,'ru',{sensitivity:'base',numeric:true}))
  const collapsedProjects=new Set(loadJson(PROJECT_COLLAPSE_KEY, [])),expanded=sessionTreeExpanded()
  const projectsHtml=orderedGroups.map(({info,items})=>`<details class="project-group" data-project="${escapeHtml(info.key)}"${collapsedProjects.has(info.key)?'':' open'}><summary class="project" draggable="true" title="${escapeHtml(info.directory)}"><span>${escapeHtml(info.label)}</span><span class="count">${items.length}</span></summary><div class="project-sessions">${items.map((session)=>renderSessionNode(session,tree.children,expanded,query)).join('')}</div></details>`).join('')
  const html=renderSessionShortcuts(collapsedProjects)+(projectsHtml||'<div class="empty">Сессий не найдено.</div>')
  if (container._lastHtml === html) return
  container._lastHtml = html
  container.innerHTML=html
  document.querySelectorAll('[data-project],[data-session-mirror]').forEach((group)=>group.addEventListener('toggle',()=>{const values=new Set(loadJson(PROJECT_COLLAPSE_KEY, [])),id=group.dataset.project||`mirror:${group.dataset.sessionMirror}`;group.open?values.delete(id):values.add(id);saveJson(PROJECT_COLLAPSE_KEY,[...values])}))
  document.querySelectorAll('[data-agent-folder]').forEach((folder)=>folder.addEventListener('toggle',()=>{const values=sessionTreeExpanded(),id=folder.dataset.agentFolder;folder.open?values.add(id):values.delete(id);saveJson(SESSION_TREE_KEY,[...values])}))
  document.querySelectorAll('[data-session]').forEach((button)=>button.addEventListener('click',()=>selectSession(button.dataset.session)))
  document.querySelectorAll('[data-session-more]').forEach((button)=>button.addEventListener('click',(event)=>{event.stopPropagation();openSessionActions(button.dataset.sessionMore)}))
}

async function selectSession(id,{push=true,saveDraft=true}={}) {
  const session=state.sessions.find((s)=>s.id===id); if(!session)return
  if(saveDraft)saveDraftNow()
  const cachedContext=state.contextCache.get(id)
  state.selected=session; state.context=cachedContext?.messages||[]; state.attachments=[]; state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
  meta(id).lastOpenedAt=Date.now();saveMeta()
  initialMessageScrollObserver?.disconnect();initialMessageScrollObserver=null;initialMessageScrollSession=id;historyPaginationIntent=false;clearTimeout(historyPaginationIntentTimer);historyPaginationIntentTimer=0;historyPaginationTouch=null
  resetPromptHistory(id)
  renderAttachments(); renderSessions(); renderHeader(); renderMessages({bottom:true}); restoreDraft(); $('sidebar').classList.remove('open')
  if(push) setSessionHash(id)
  window.dispatchEvent(new CustomEvent('custom-opencode:session-selected',{detail:{sessionID:id}}))
  renderControls()
  const initialAgent=session.agent
  const modelVersionAtStart=sessionModelVersions.get(id)
  const [detail]=await Promise.all([api.getSession(id).catch(()=>null),loadContext({force:Boolean(cachedContext),initial:true}),loadControls(),refreshGit()])
  if(detail&&state.selected?.id===id){const liveAgent=state.selected.agent,liveModel=state.selected.model&&{...state.selected.model},model=detail.model&&sessionModelFromRead(id,detail.model,modelVersionAtStart,liveModel);state.selected={...state.selected,...detail,...(liveAgent!==initialAgent?{agent:liveAgent}:{}),...(model?{model}:{})};const index=state.sessions.findIndex((item)=>item.id===id);if(index>=0)state.sessions[index]=state.selected;renderHeader();renderControls()}
}
function clearSelection() {
  saveDraftNow();initialMessageScrollObserver?.disconnect();initialMessageScrollObserver=null;initialMessageScrollSession=null;historyPaginationIntent=false;clearTimeout(historyPaginationIntentTimer);historyPaginationIntentTimer=0;historyPaginationTouch=null; state.selected=null;state.context=[];state.attachments=[];state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
  resetPromptHistory(null)
  location.hash=''
  window.dispatchEvent(new CustomEvent('custom-opencode:session-selected',{detail:{sessionID:null}}))
  renderSessions();renderHeader();renderMessages();renderAttachments();restoreDraft();loadDraftControls()
}
function setSessionHash(id) { const next=`#/session/${encodeURIComponent(id)}`; if(location.hash!==next) history.pushState(null,'',next) }
function sessionIdFromHash() { const match=/^#\/session\/([^/?]+)/.exec(location.hash); return match?decodeURIComponent(match[1]):null }
function contextMessages(messages) { return (Array.isArray(messages)?messages:[]).filter((message)=>['user','assistant'].includes(message?.type)||['user','assistant'].includes(message?.role)) }
function messageKey(message) {
  const id=message?.id||message?.messageID||message?.info?.id
  if(id)return `id:${id}`
  const role=message?.type||message?.role||''
  const created=message?.time?.created||message?.createdAt||''
  return `anonymous:${role}:${created}:${messagePlainText(message)}`
}
function mergeContextMessages(current,incoming,older=false) {
  const rows=older?[...incoming,...current]:[...current,...incoming],merged=new Map()
  rows.forEach((message)=>merged.set(messageKey(message),message))
  return [...merged.values()]
}
function contextCacheFor(id) {
  let value=state.contextCache.get(id)
  if(!value){value={messages:[],loaded:false,loading:false,nextCursor:null,hasMore:true,complete:false,seenCursors:new Set()};state.contextCache.set(id,value)}
  return value
}
function setContextPageCursor(cache,cursor,nextCursor) {
  if(!nextCursor||nextCursor===cursor||cache.seenCursors.has(nextCursor)){cache.nextCursor=null;cache.hasMore=false;return}
  cache.nextCursor=nextCursor;cache.hasMore=true
}
async function loadContext({force=false,initial=false}={}) {
  if(!state.selected)return
  const id=state.selected.id,cache=contextCacheFor(id)
  if(cache.loaded&&!force){state.context=cache.messages;syncPromptHistory();renderMessages({bottom:initial});renderUsage();return}
  if(cache.loading)return
  cache.loading=true
  const wasLoaded=cache.loaded
  try {
    const page=await api.getContextPage(id,{limit:CONTEXT_PAGE_SIZE})
    const incoming=contextMessages(page.messages)
    const hadConversation=cache.messages.length>0
    cache.messages=wasLoaded?mergeContextMessages(cache.messages,incoming):incoming
    cache.loaded=true
    if(!wasLoaded){cache.complete=Boolean(page.complete);setContextPageCursor(cache,'',page.nextCursor)}
    else if(page.complete){cache.complete=true;cache.nextCursor=null;cache.hasMore=false}
    else if(!cache.hasMore&&cache.messages.length<=incoming.length)setContextPageCursor(cache,'',page.nextCursor)
    if(!hadConversation&&cache.messages.length)renderSessions()
    if(state.selected?.id===id){
      state.context=cache.messages
      syncPromptHistory();renderMessages({bottom:initial||!wasLoaded});renderUsage()
    }
  }catch(error){
    if(state.selected?.id===id){if(cache.messages.length)toast(`История: ${error.message}`);else $('messagesInner').innerHTML=`<div class="empty">Не удалось открыть сессию: ${escapeHtml(error.message)}</div>`}
  }finally{
    cache.loading=false
  }
}
async function loadOlderContext() {
  const id=state.selected?.id,cache=id&&state.contextCache.get(id),view=$('messages')
  if(!id||!cache?.loaded||cache.loading||!cache.hasMore||!cache.nextCursor||!view)return
  const cursor=cache.nextCursor
  if(cache.seenCursors.has(cursor)){cache.nextCursor=null;cache.hasMore=false;return}
  cache.seenCursors.add(cursor);cache.loading=true
  const anchor={top:view.scrollTop,height:view.scrollHeight}
  try {
    const page=await api.getContextPage(id,{cursor,limit:CONTEXT_PAGE_SIZE})
    cache.messages=mergeContextMessages(cache.messages,contextMessages(page.messages),true)
    if(page.complete){cache.complete=true;cache.nextCursor=null;cache.hasMore=false}
    else setContextPageCursor(cache,cursor,page.nextCursor)
    if(state.selected?.id===id){
      state.context=cache.messages
      syncPromptHistory();renderMessages({anchor});renderUsage()
    }
  }catch(error){
    cache.seenCursors.delete(cursor)
    if(state.selected?.id===id)toast(`История: ${error.message}`)
  }
  finally{
    cache.loading=false
  }
}
function scheduleContextReload(delay=250) { clearTimeout(contextReloadTimer); contextReloadTimer=setTimeout(()=>loadContext({force:true}),delay) }

async function loadControls() {
  if(!state.selected)return
  const id=state.selected.id
  try { const catalog=await api.getControls(directory(state.selected)); if(state.selected?.id!==id)return; applyControls(catalog) }
  catch(error){toast(`Настройки: ${error.message}`)}
}
async function loadDraftControls() {
  if(state.selected||!state.clientConfig?.scratchDirectory)return
  state.draftModel ||= loadLastModel()
  try { const catalog=await api.getControls(state.clientConfig.scratchDirectory); if(state.selected)return; state.draftAgent ||= catalog.agents.find((a)=>a.id==='build-direct')?.id||catalog.agents.find((a)=>a.id==='build')?.id||catalog.agents[0]?.id; if(state.draftModel&&!catalog.models.some((m)=>m.id===state.draftModel.id&&m.providerID===state.draftModel.providerID))state.draftModel=null; state.draftModel ||= catalog.fallback && {id:catalog.fallback.id,providerID:catalog.fallback.providerID}; applyControls(catalog) }
  catch(error){toast(`Настройки: ${error.message}`)}
}
function applyControls(catalog){state.agents=catalog.agents;state.models=catalog.models;state.providers=catalog.providers;state.defaultModel=catalog.fallback;renderControls();renderUsage()}
function modelVariants(model){
  const source=model?.variants??model?.options?.variants??{}
  const variants=Array.isArray(source)?source.map((v)=>({...v})):Object.entries(source).map(([id,v])=>({id,...(v&&typeof v==='object'?v:{})}))
  if(!variants.some((v)=>v.id==='xhigh')&&(model?.settings?.effort==='xhigh'||variants.some((v)=>v.settings?.effort==='xhigh'))) variants.push({id:'xhigh',settings:{effort:'xhigh'}})
  return variants.filter((v)=>v.id)
}
function renderControls(){
  const agentID=state.selected?.agent||(!state.selected&&state.draftAgent)||state.agents.find((a)=>a.id==='build')?.id||state.agents[0]?.id
  const mode=modeFromAgent(agentID)
  $('agentControls').innerHTML=state.agents.map((agent)=>`<button type="button" class="${agent.id===agentID||(['build','plan'].includes(agent.id)&&agent.id===mode)?'active':''}" data-agent="${escapeHtml(agent.id)}">${escapeHtml(agent.name||agent.id)}</button>`).join('')
  document.querySelectorAll('[data-agent]').forEach((b)=>b.addEventListener('click',()=>changeAgent(b.dataset.agent)))
  const ref=activeModelRef(), model=activeModel(), selectedVariant=ref?.variant||''; $('modelButton').disabled=!state.models.length; $('modelButton').textContent=modelRefLabel(ref)||'Модель'
  const variants=modelVariants(model)
  const configuredEffort=model?.settings?.effort||''
  $('variantSelect').innerHTML=variants.length?`<option value="">${escapeHtml(configuredEffort||'default')}</option>${variants.map((v)=>`<option value="${escapeHtml(v.id)}">${escapeHtml(v.id)}</option>`).join('')}`:'<option value="">—</option>'
  $('variantSelect').value=selectedVariant; $('variantSelect').disabled=!variants.length
}
async function changeAgent(agent){const sessionID=state.selected?.id||null,previous=state.selected?.agent||state.draftAgent;if(!state.selected){state.draftAgent=agent;renderControls();window.dispatchEvent(new CustomEvent('custom-opencode:agent-changed',{detail:{sessionID,agent,previousAgent:previous,ok:true}}));return true}state.selected.agent=agent;renderControls();try{await api.switchAgent(sessionID,agent);if(state.selected?.id!==sessionID){window.dispatchEvent(new CustomEvent('custom-opencode:agent-changed',{detail:{sessionID,agent,previousAgent:previous,ok:false,error:'session changed'}}));return false}window.dispatchEvent(new CustomEvent('custom-opencode:agent-changed',{detail:{sessionID,agent,previousAgent:previous,ok:true}}));return true}catch(e){if(state.selected?.id===sessionID&&state.selected.agent===agent){state.selected.agent=previous;renderControls()}toast(`Режим: ${e.message}`);window.dispatchEvent(new CustomEvent('custom-opencode:agent-changed',{detail:{sessionID,agent,previousAgent:previous,ok:false,error:String(e?.message||e)}}));return false}}
async function changeModel(model){const sessionID=state.selected?.id||null,previousModel=activeModelRef()?{...activeModelRef()}:null;if(!state.selected){state.draftModel={...model};saveLastModel(model);renderControls();dispatchModelChanged(sessionID,model,previousModel,true);return true}return queueSessionModelChange(sessionID,async()=>{if(!hasSession(sessionID)){dispatchModelChanged(sessionID,model,previousModel,false,'session removed');return false}try{await api.switchModel(sessionID,model);if(!hasSession(sessionID)){dispatchModelChanged(sessionID,model,previousModel,false,'session removed');return false}sessionModelVersions.set(sessionID,(sessionModelVersions.get(sessionID)||0)+1);sessionModelOverrides.set(sessionID,{model:{...model}});setSessionModel(sessionID,model);if(state.selected?.id===sessionID){saveLastModel(model);renderControls();renderUsage()}dispatchModelChanged(sessionID,model,previousModel,true);return true}catch(e){if(state.selected?.id===sessionID)toast(`Модель: ${e.message}`);dispatchModelChanged(sessionID,model,previousModel,false,String(e?.message||e));return false}})}
function directModelRef(){
  const current=activeModelRef()
  if(current&&!ORCHESTRATED_MODELS.some((model)=>model.id===current.id&&model.providerID===current.providerID))return {...current}
  return state.defaultModel?{...state.defaultModel}:null
}
window.CustomOpenCodeControls={changeModel,changeAgent,activeModel:activeModelRef,directModel:directModelRef,startRun:markStarted}

const NIGHT_DISCOUNT_MODELS = new Set([
  'qwen3.8-max',
  'qwen3.8-orchestrated',
  'qwen3.8-max-preview',
  'deepseek-v4-pro-0813',
  'deepseek-v4-flash-0731',
])
function isNightPromoActive(nowMs = Date.now()){
  const bj = new Date(nowMs + 8 * 3600 * 1000)
  const min = bj.getUTCHours() * 60 + bj.getUTCMinutes()
  return min >= 22 * 60 || min < 8 * 60
}
function isNightPromoModel(modelID, providerID){
  if(providerID && providerID !== 'bailian-cli') return false
  return NIGHT_DISCOUNT_MODELS.has(modelID)
}

function renderModelChoices(){
  const query=$('modelSearch').value.trim().toLowerCase(), current=activeModelRef()
  const models=state.models.filter((m)=>`${m.name||''} ${m.id} ${m.providerID}`.toLowerCase().includes(query))
  const groups=new Map(); for(const m of models){if(!groups.has(m.providerID))groups.set(m.providerID,[]);groups.get(m.providerID).push(m)}
  const favKey=(m)=>`${m.providerID}/${m.id}`
  const nightActive=isNightPromoActive()
  $('modelChoices').innerHTML=[...groups.entries()].sort((a,b)=>providerName(a[0]).localeCompare(providerName(b[0]))).map(([pid,items])=>`<div class="project">${escapeHtml(providerName(pid))}</div>${items.sort((a,b)=>Number(favorites.has(favKey(b)))-Number(favorites.has(favKey(a)))||(a.name||a.id).localeCompare(b.name||b.id)).map((m)=>{
    const promo=isNightPromoModel(m.id,m.providerID)
    const promoClass=promo?(nightActive?'night-promo-active':'night-promo-inactive'):''
    const promoBadge=promo?`<span class="night-promo-badge ${nightActive?'active':'inactive'}">${nightActive?'🌙 −50%':'☀ −50%'}</span>`:''
    return `<button class="choice ${promoClass}" data-model="${escapeHtml(m.id)}" data-provider="${escapeHtml(m.providerID)}" data-promo="${promo?1:0}"><div class="choice-title">${escapeHtml(m.name||m.id)}${current?.id===m.id&&current?.providerID===m.providerID?' · ✓':''}</div><div class="choice-meta">${promoBadge ? promoBadge + ' · ' : ''}${escapeHtml(m.id)} · <span data-fav="${escapeHtml(favKey(m))}">${favorites.has(favKey(m))?'★':'☆'}</span></div></button>`
  }).join('')}`).join('')||'<div class="empty">Модели не найдены.</div>'
}

function renderHeader(){
  const s=state.selected; $('headerTitle').textContent=s?sessionTitle(s):'OpenCode'; $('sessionActions').disabled=!s
  $('headerSub').textContent=s?`${projectInfo(s).label} · ${directory(s)}${isRunning(s.id)?' · выполняется':''}`:''
  renderRunControls(); renderUsage(); renderGitButton(); renderNotifyButton()
}
let rateLimitActiveState=false
const pollRateLimitCoalesced=createRefreshCoalescer()
function pollRateLimit(force=false){if(force)rateLimitSyncGeneration+=1;return pollRateLimitCoalesced(pollRateLimitNow,force)}
async function pollRateLimitNow(){
  const generation=++rateLimitSyncGeneration
  if(!state.running.size){
    if(rateLimitActiveState){
      rateLimitActiveState=false
      const span=$('chatStatus')?.querySelector('span:not(.run-dot)')
      if(span)span.textContent='Модель работает…'
    }
    return
  }
  try{
    const res=await fetch('/client-rate-limit.json')
    if(!res.ok)return
    const data=await res.json()
    if(generation!==rateLimitSyncGeneration||!state.running.size)return
    const span=$('chatStatus')?.querySelector('span:not(.run-dot)')
    if(data?.active&&data?.seconds>0){
      rateLimitActiveState=true
      if(span)span.textContent=`Лимит Gemini (429): повтор через ${data.seconds}с…`
      window.dispatchEvent(new CustomEvent('custom-rate-limit', { detail: data }))
    }else if(rateLimitActiveState){
      rateLimitActiveState=false
      if(span)span.textContent='Модель работает…'
      window.dispatchEvent(new CustomEvent('custom-rate-limit', { detail: { active: false, seconds: 0 } }))
    }
  }catch{}
}
function renderRunControls(){
  const running=!!state.selected&&isRunning(state.selected.id); $('stop').hidden=!running; $('deliveryControls').hidden=!running
  $('chatStatus').hidden=!running
  if(!running&&rateLimitActiveState){
    rateLimitActiveState=false
    const span=$('chatStatus')?.querySelector('span:not(.run-dot)')
    if(span)span.textContent='Модель работает…'
  }
  document.querySelectorAll('[data-delivery]').forEach((b)=>b.classList.toggle('active',b.dataset.delivery===state.deliveryMode))
  $('input').placeholder=running?(state.deliveryMode==='queue'?'Сообщение будет отправлено после завершения…':'Steer: скорректировать текущую работу…'):'Сообщение…'
}

function clipped(value,limit=16000){if(value===undefined||value===null)return'';let text;try{text=typeof value==='string'?value:JSON.stringify(value,null,2)}catch{text=String(value)}return text.length>limit?`${text.slice(0,limit)}\n…обрезано…`:text}
function imagePart(part){const mime=part.mime||part.mimeType||part.type==='image'&&'image/*';const uri=part.uri||part.url||part.data;return mime?.startsWith?.('image/')||String(uri||'').startsWith('data:image/')?uri:null}
function assistantBody(message){
  const parts=message.content||message.parts||[],texts=[],images=[]
  for(const part of parts){if(part.type==='text'&&part.text)texts.push(part.text);else{const img=imagePart(part);if(img)images.push(img)}}
  if(!texts.length&&message.text)texts.push(message.text)
  return `${texts.map((text)=>`<div class="markdown">${renderMarkdown(text)}</div>`).join('')}${images.map((src)=>`<img class="image-preview" src="${escapeHtml(src)}" alt="image">`).join('')}${message.error?`<div class="markdown">${renderMarkdown(`**Ошибка:** ${message.error.message||message.error}`)}</div>`:''}`
}
function userBody(message){const files=(message.files||[]).map((f)=>`<span class="file-chip">${escapeHtml(f.name||f.mime||'файл')}</span>`).join('');return `<div class="markdown">${renderMarkdown(message.text||'')}</div>${files?`<div>${files}</div>`:''}`}
function messagePlainText(message){
  if((message.type||message.role)==='user')return message.text||''
  const parts=message.content||message.parts||[];return parts.filter((p)=>p.type==='text').map((p)=>p.text||'').join('\n')||message.text||''
}
function promptHistoryEntries(){
  if(!state.selected)return []
  return state.context.filter((message)=>message.type==='user'||message.role==='user').map(messagePlainText).map((text)=>text.trim()).filter(Boolean)
}
function resetPromptHistory(sessionID=state.selected?.id||null){
  const entries=sessionID?promptHistoryEntries():[]
  promptHistory={sessionID,entries,cursor:entries.length,draft:'',value:''}
}
function syncPromptHistory(){
  const sessionID=state.selected?.id||null
  if(promptHistory.sessionID!==sessionID){resetPromptHistory(sessionID);return}
  const entries=promptHistoryEntries()
  const wasAtEnd=promptHistory.cursor===promptHistory.entries.length
  promptHistory.entries=entries
  if(wasAtEnd||promptHistory.cursor>entries.length)promptHistory.cursor=entries.length
  if(promptHistory.cursor===entries.length)promptHistory.value=$('input')?.value||promptHistory.value
}
function rememberSubmittedPrompt(sessionID,text){
  if(!sessionID||!text.trim())return
  if(promptHistory.sessionID!==sessionID)resetPromptHistory(sessionID)
  if(promptHistory.entries[promptHistory.entries.length-1]!==text.trim())promptHistory.entries.push(text.trim())
  promptHistory.cursor=promptHistory.entries.length
  promptHistory.draft=''
  promptHistory.value=''
}
function notePromptInput(){
  if(applyingPromptHistory)return
  syncPromptHistory()
  promptHistory.cursor=promptHistory.entries.length
  promptHistory.draft=$('input').value
  promptHistory.value=promptHistory.draft
}
function applyPromptHistoryValue(value){
  const input=$('input')
  applyingPromptHistory=true
  input.value=value
  input.setSelectionRange(value.length,value.length)
  promptHistory.value=value
  autosizeInput()
  queueMicrotask(()=>{applyingPromptHistory=false})
}
function navigatePromptHistory(direction,event){
  if(!state.selected||event.shiftKey||event.altKey||event.ctrlKey||event.metaKey)return false
  const input=$('input')
  if(input.selectionStart!==input.selectionEnd)return false
  syncPromptHistory()
  const browsing=promptHistory.cursor<promptHistory.entries.length&&input.value===promptHistory.value
  const singleLine=!input.value.includes('\n')
  const atBoundary=singleLine||(direction<0?input.selectionStart===0:input.selectionEnd===input.value.length)
  if(!browsing&&!atBoundary)return false
  if(!promptHistory.entries.length)return false
  const current=input.value
  if(promptHistory.cursor!==promptHistory.entries.length&&current!==promptHistory.value){
    promptHistory.cursor=promptHistory.entries.length
    promptHistory.draft=current
  }
  if(promptHistory.cursor===promptHistory.entries.length&&direction<0)promptHistory.draft=current
  const next=Math.max(0,Math.min(promptHistory.entries.length,promptHistory.cursor+direction))
  if(next===promptHistory.cursor)return true
  promptHistory.cursor=next
  applyPromptHistoryValue(next===promptHistory.entries.length?promptHistory.draft:promptHistory.entries[next])
  return true
}
function isAgentSession(session) { return Boolean(session?.parentID||session?.parentSessionID) }
function modelRefLabel(ref) {
  if(!ref)return''
  const value=typeof ref==='string'?{id:ref}:ref
  const id=String(value?.id||value?.modelID||'')
  const provider=String(value?.providerID||value?.provider||'')
  const catalog=state.models.find((model)=>model.id===id&&(!provider||model.providerID===provider))
  const label=String(catalog?.name||ORCHESTRATED_MODELS.find(model=>model.id===id&&model.providerID===provider)?.label||id||'')
  return label||(provider?provider:'')
}
function messageOriginHint(message) {
  const info=message?.info||{}
  return [message?.origin,message?.source,message?.authorType,message?.generatedBy,info.origin,info.source,info.authorType,info.generatedBy].filter(Boolean).join(' ')
}
function messagePresentation(message,type) {
  const info=message?.info||{}
  if(type==='user'){
    const delegated=isAgentSession(state.selected)||/(agent|assistant|model|synthetic|delegat|subagent)/i.test(messageOriginHint(message))
    if(!delegated)return{origin:'human',avatar:'Я',role:'Ты'}
    const target=String(state.selected?.agent||'').trim()
    return{origin:'agent-prompt',avatar:'A',role:target?`Запрос модели/агента → ${target}`:'Запрос модели/агента'}
  }
  const agent=String(info.agent||message?.agent||state.selected?.agent||'').trim()
  const model=modelRefLabel(info.model||message?.model||state.selected?.model)
  if(isAgentSession(state.selected))return{origin:'agent-response',avatar:'AI',role:`Агент ${agent||'subagent'}${model?` · ${model}`:''}`}
  return{origin:'model-response',avatar:'AI',role:model?`Модель · ${model}`:'OpenCode'}
}
function renderMessages({anchor=null,bottom=false}={}){
  const inner=$('messagesInner'), view=$('messages');
  if(!state.selected){
    if(inner._lastHtml!=='welcome1'){inner.innerHTML='<div class="welcome">Выбери сессию или задай быстрый вопрос.</div>';inner._lastHtml='welcome1'}
    updateScrollToBottomButton();return
  }
  if(!state.context.length&&!isRunning(state.selected.id)){
    if(inner._lastHtml!=='welcome2'){inner.innerHTML='<div class="welcome">Пока нет сообщений.</div>';inner._lastHtml='welcome2'}
    updateScrollToBottomButton();return
  }
  const stick=view.scrollHeight-view.scrollTop-view.clientHeight<100; const prev=view.scrollTop
  const rows=state.context.map((message,index)=>{const type=message.type||message.role;return{message,index,type,body:type==='user'?userBody(message):assistantBody(message)}}).filter(({type,body})=>type==='user'||body)
  const articleHtmls=rows.map(({message,index,type,body})=>{const id=message.id||message.messageID||`idx-${index}`;const actor=messagePresentation(message,type),family=type==='user'?'user':'assistant';return `<article class="message ${family} ${actor.origin}" data-message-index="${index}" data-origin="${escapeHtml(actor.origin)}"><div class="avatar">${escapeHtml(actor.avatar)}</div><div class="message-body"><div class="message-head"><span class="message-role">${escapeHtml(actor.role)}</span><span class="message-actions"><button class="mini" data-copy-message="${index}">Copy</button><button class="mini" data-fork-message="${escapeHtml(id)}">Fork</button></span></div>${body}</div></article>`})
  const fullHtml=articleHtmls.join('')

  if(inner._lastHtml===fullHtml&&!anchor&&!bottom){
    updateScrollToBottomButton()
    return
  }

  const existingArticles=inner.querySelectorAll(':scope > article.message')
  if(existingArticles.length===articleHtmls.length&&!inner.querySelector('.welcome')){
    for(let i=0;i<articleHtmls.length;i++){
      const art=existingArticles[i]
      if(art._articleHtml!==articleHtmls[i]){
        art._articleHtml=articleHtmls[i]
        const temp=document.createElement('div')
        temp.innerHTML=articleHtmls[i]
        const newEl=temp.firstElementChild
        if(newEl){
          newEl._articleHtml=articleHtmls[i]
          inner.replaceChild(newEl,art)
        }
      }
    }
  }else{
    inner.innerHTML=fullHtml
    const children=inner.querySelectorAll(':scope > article.message')
    for(let i=0;i<children.length;i++){
      children[i]._articleHtml=articleHtmls[i]
    }
  }
  inner._lastHtml=fullHtml
  if(anchor)view.scrollTop=anchor.top+view.scrollHeight-anchor.height
  else if(bottom){
    const sessionID=state.selected?.id,stabilize=initialMessageScrollSession===sessionID
    view.scrollTo({top:view.scrollHeight,behavior:'instant'})
    if(stabilize){
      initialMessageScrollObserver?.disconnect()
      initialMessageScrollObserver=null
      let settling=true,observer=null
      const stopSettling=()=>{
        settling=false
        if(initialMessageScrollSession===sessionID)initialMessageScrollSession=null
        if(initialMessageScrollObserver===observer){observer?.disconnect();initialMessageScrollObserver=null}
      }
      const settleBottom=()=>{if(!settling||state.selected?.id!==sessionID||initialMessageScrollSession!==sessionID)return;view.scrollTo({top:view.scrollHeight,behavior:'instant'});updateScrollToBottomButton()}
      if('ResizeObserver' in window){
        observer=new ResizeObserver(settleBottom)
        initialMessageScrollObserver=observer
        observer.observe(inner)
        observer.observe(view)
      }
      setTimeout(stopSettling,1500)
      const frames=new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
      const fonts=document.fonts?.ready?document.fonts.ready.catch(()=>{}):Promise.resolve()
      Promise.all([frames,fonts]).then(settleBottom)
    }
  }
  else if(stick)view.scrollTop=view.scrollHeight
  else view.scrollTop=prev
  updateScrollToBottomButton()
}

// Streaming SSE events can arrive much faster than the browser can paint.
// Keep their state updates synchronous, but render the accumulated result once
// per frame. Explicit navigation/history renders still call renderMessages.
function scheduleMessageRender(){
  if(messageRenderFrame!==null)return
  const render=()=>{messageRenderFrame=null;renderMessages()}
  messageRenderFrame=typeof requestAnimationFrame==='function'?requestAnimationFrame(render):setTimeout(render,0)
}

function messagesAtBottom(view=$('messages')){return !view||view.scrollHeight-view.clientHeight-view.scrollTop<=100}
function updateScrollToBottomButton(){const button=$('scrollToBottom'),view=$('messages');if(button)button.hidden=!state.selected||messagesAtBottom(view)}
function scrollMessagesToBottom(){const view=$('messages');if(!view)return;view.scrollTo({top:view.scrollHeight,behavior:'instant'});updateScrollToBottomButton()}

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
function gitBranch(){const v=state.git.vcs;return [v,v?.branch,v?.name,v?.ref].find(value=>typeof value==='string'&&value.trim())||''}
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
async function createAt(dir,title){
  if(!dir)throw new Error('Не выбрана папка для новой сессии')
  const source=state.selected
  const session=await api.createSession({directory:dir,title,agent:source?.agent||state.draftAgent,model:source?.model||state.draftModel})
  if(!session?.id)throw new Error('OpenCode не вернул id новой сессии')
  state.sessions=[session,...state.sessions.filter((s)=>s.id!==session.id)]
  await selectSession(session.id)
  return session
}
async function createNewSession(){
  const dir=state.clientConfig?.scratchDirectory
  try{await createAt(dir,'Новая сессия')}
  catch(error){toast(`Создание: ${error.message}`)}
}
async function sendMessage(event){
  event?.preventDefault();const input=$('input'),text=input.value.trim();if(!text&&!state.attachments.length)return
  const claimedAttachments=state.attachments,files=claimedAttachments.map(({uri,name,mime})=>({uri,name,mime}))
  input.value='';state.attachments=[];drafts[draftKey()]='';saveJson(DRAFT_KEY,drafts);renderAttachments();autosizeInput()
  let session=null,previousRun
  try {
    session=await ensureQuickSession();const running=isRunning(session.id)
    if(running&&state.deliveryMode==='queue'){
      queueFor(session.id).push({text,files});rememberSubmittedPrompt(session.id,text);renderSessions();toast('Добавлено в очередь');return
    }
    previousRun=state.running.get(session.id)
    invalidateRunSync();state.running.set(session.id,{status:running?'steer':'running',since:Date.now()});if(!running){statusPolling.wake();rateLimitPolling.wake()}renderHeader();renderSessions();updateBadge()
    await api.sendPrompt(session,{text,files,delivery:running?'steer':'normal'});rememberSubmittedPrompt(session.id,text);setTimeout(()=>loadContext({force:true}),180)
  } catch(error){
    if(session){invalidateRunSync();previousRun?state.running.set(session.id,previousRun):state.running.delete(session.id);renderHeader();renderSessions();updateBadge()}
    toast(`Отправка: ${error.message}`)
    if(text&&!input.value)input.value=text
    if(claimedAttachments.length){state.attachments=[...claimedAttachments,...state.attachments];renderAttachments()}
    drafts[draftKey()]=input.value;saveJson(DRAFT_KEY,drafts);autosizeInput()
  }
}
async function flushQueue(sessionID){const queue=queueFor(sessionID);if(!queue.length||isRunning(sessionID))return;const session=state.sessions.find((s)=>s.id===sessionID);if(!session)return;const next=queue.shift();invalidateRunSync();state.running.set(sessionID,{status:'queued-start',since:Date.now()});statusPolling.wake();rateLimitPolling.wake();renderSessions();if(state.selected?.id===sessionID)renderHeader();updateBadge();try{await api.sendPrompt(session,{...next,delivery:'normal'})}catch(e){invalidateRunSync();state.running.delete(sessionID);queue.unshift(next);notifyUser('OpenCode: очередь остановлена',e.message,`queue-${sessionID}`)}renderSessions();if(state.selected?.id===sessionID)renderHeader();updateBadge()}
async function stopSelected(){if(!state.selected)return;try{await api.abortSession(state.selected.id);toast('Остановка отправлена')}catch(e){toast(`Остановка: ${e.message}`)}}

function openProjectDialog(mode='create'){state.projectDialogMode=mode;const titles={copy:'Копировать с контекстом',move:'Перенести в проект'};$('projectDialogTitle').textContent=titles[mode]||'Создать в проекте';const currentDirectory=directory(state.selected);const projects=state.projects.filter((p)=>p.id!==QUICK_PROJECT_ID&&!(mode==='move'&&(p.id===state.selected?.projectID||p.canonical===currentDirectory)));$('projectChoices').hidden=false;$('projectBrowser')?.setAttribute('hidden','');$('projectChoices').innerHTML=projects.map((p)=>`<button class="choice" data-project="${escapeHtml(p.id)}"><div class="choice-title">${escapeHtml(projectLabel(p))}</div><div class="choice-meta">${escapeHtml(p.canonical||p.id)}</div></button>`).join('')||'<div class="empty">Проекты не найдены.</div>';$('projectChoices').querySelectorAll('button[data-project]').forEach((b)=>b.addEventListener('click',()=>chooseProject(b.dataset.project)));$('projectDialog').showModal()}
async function selectProjectTarget(project){if(!project?.canonical)return;$('projectDialog').close();if(state.projectDialogMode==='copy'||state.projectDialogMode==='move')await continueInProject(project,state.projectDialogMode==='move');else try{await createAt(project.canonical,'Новая сессия')}catch(e){toast(`Создание: ${e.message}`)}}
async function chooseProject(projectID){await selectProjectTarget(state.projects.find((p)=>p.id===projectID))}
window.CustomOpenCodeProjects={selectDirectory:async(directory)=>selectProjectTarget({canonical:directory,name:String(directory).split(/[\\/]/).filter(Boolean).at(-1)||directory})}
function handoffText(sourceSession,sourceContext){const rows=sourceContext.slice(-40).map((m)=>`${(m.type||m.role)==='user'?'USER':'ASSISTANT'}:\n${messagePlainText(m)}`).join('\n\n');const clippedRows=rows.length>24000?rows.slice(-24000):rows;return `Продолжи работу из предыдущей OpenCode-сессии. Это перенос контекста, а не новая независимая задача.\n\nИсходная сессия: ${sourceSession?.id}\nИсходная директория: ${directory(sourceSession)}\n\nПоследний контекст:\n${clippedRows}`}
async function continueInProject(project,removeSource=false){if(!state.selected)return;if(removeSource&&!await confirmAction('Перенести через handoff?',`OpenCode не умеет менять папку существующей сессии. Будут перенесены последние 40 текстовых сообщений (до 24 000 символов), но не файлы проекта и полная tool-история. После успешного handoff исходная сессия будет удалена.`))return;try{const result=await transferSessionToProject(state.selected,project,{select:true,removeSource});toast(removeSource?(result.sourceRemoved?'Сессия перенесена':'Создана копия; исходная сессия сохранена'):'Создана копия с контекстом')}catch(e){toast(`${removeSource?'Перенос':'Копирование'}: ${e.message}`)}}

async function forkWithFallback(session,messageID){
  try { return await api.forkSession(session.id,messageID) }
  catch(error){
    if(error.status!==404&&error.status!==405)throw error
    const sourceSession=await sessionWithControls(session)
    const sourceContext=state.context
    let end=sourceContext.length
    if(messageID){const idx=sourceContext.findIndex((m)=>m.id===messageID||m.messageID===messageID);if(idx>=0)end=idx+1}
    const context=sourceContext.slice(0,end)
    const created=await api.createSession({directory:directory(sourceSession),title:`${sessionTitle(sourceSession)} · fork`,agent:primaryAgentFor(sourceSession.model,sourceSession.agent),model:sourceSession.model})
    if(!created?.id)throw new Error('OpenCode не вернул id новой сессии')
    if(context.length){
      const handoff=handoffText(sourceSession,context)
      state.running.set(created.id,{status:'fork-handoff',since:Date.now()})
      try{await api.sendPrompt(created,{text:handoff,files:[],delivery:'normal'})}
      catch(promptError){state.running.delete(created.id);try{await api.deleteSession(created.id)}catch{};throw promptError}
    }
    return created
  }
}

function openSessionActions(id=state.selected?.id){const session=state.sessions.find((s)=>s.id===id);if(!session)return;state.actionSession=session;const m=meta(session.id);$('sessionActionList').innerHTML=`<button class="action" data-action="rename">Переименовать</button><button class="action" data-action="pin">${m.pinned?'Открепить':'Закрепить'}</button><button class="action" data-action="duplicate">Дублировать (Fork)</button><button class="action" data-action="fork-last">Fork от последнего сообщения</button><button class="action" data-action="copy-context">Копировать с контекстом…</button><button class="action" data-action="move-project">Перенести через handoff…</button><button class="action" data-action="delete">Удалить</button>`;document.querySelectorAll('[data-action]').forEach((b)=>b.addEventListener('click',()=>runSessionAction(b.dataset.action)));$('sessionDialog').showModal()}
async function runSessionAction(action){const session=state.actionSession;if(!session)return;$('sessionDialog').close();if(action==='rename'){state.actionSession=session;$('renameInput').value=sessionTitle(session);$('renameDialog').showModal();$('renameInput').focus();return}if(action==='pin'){meta(session.id).pinned=!meta(session.id).pinned;saveMeta();renderSessions();return}if(action==='copy-context'||action==='move-project'){if(state.selected?.id!==session.id)await selectSession(session.id);openProjectDialog(action==='move-project'?'move':'copy');return}if(action==='duplicate'||action==='fork-last'){try{if(state.selected?.id!==session.id)await selectSession(session.id);const mid=action==='fork-last'?(state.context.at(-1)?.id||state.context.at(-1)?.messageID):undefined;const fork=await forkWithFallback(session,mid);state.sessions=[fork,...state.sessions.filter((s)=>s.id!==fork.id)];await selectSession(fork.id);toast('Fork создан')}catch(e){toast(`Fork: ${e.message}`)}return}if(action==='delete'){if(await confirmAction('Удалить сессию?',`«${sessionTitle(session)}» будет удалена без возможности восстановления.`))await removeSession(session)}}
async function removeSession(session){try{await api.deleteSession(session.id);state.sessions=state.sessions.filter((s)=>s.id!==session.id);delete sessionMeta[session.id];delete drafts[session.id];saveMeta();saveJson(DRAFT_KEY,drafts);state.running.delete(session.id);state.queues.delete(session.id);clearSessionModelState(session.id);if(state.selected?.id===session.id)clearSelection();else renderSessions();toast('Сессия удалена')}catch(e){toast(`Удаление: ${e.message}`)}}
async function renameCurrent(){const session=state.actionSession||state.selected;if(!session)return;const title=$('renameInput').value.trim();if(!title)return;try{const updated=await api.renameSession(session.id,title);session.title=updated?.title||title;$('renameDialog').close();renderSessions();renderHeader()}catch(e){toast(`Rename: ${e.message}`)}}
async function forkAtMessage(messageID){if(!state.selected)return;try{const fork=await forkWithFallback(state.selected,messageID.startsWith('idx-')?undefined:messageID);state.sessions=[fork,...state.sessions.filter((s)=>s.id!==fork.id)];await selectSession(fork.id);toast('Fork создан')}catch(e){toast(`Fork: ${e.message}`)}}

  function confirmAction(title,text){return new Promise((resolve)=>{const d=$('confirmDialog');$('confirmTitle').textContent=title;$('confirmText').textContent=text;let settled=false;const onClose=()=>cleanup(false);const cleanup=(value)=>{if(settled)return;settled=true;d.removeEventListener('close',onClose);d.close();$('confirmOk').onclick=null;$('confirmCancel').onclick=null;resolve(value)};d.addEventListener('close',onClose);$('confirmOk').onclick=()=>cleanup(true);$('confirmCancel').onclick=()=>cleanup(false);d.showModal()})}

// `navigator.serviceWorker.ready` never settles when registration failed or
// the context is not secure; awaiting it forever would silently swallow every
// notification. Race it against a short timeout instead.
function serviceWorkerReady(timeoutMs=1500){
  if(!('serviceWorker' in navigator))return Promise.resolve(null)
  return Promise.race([
    navigator.serviceWorker.ready.catch(()=>null),
    new Promise((resolve)=>setTimeout(()=>resolve(null),timeoutMs)),
  ])
}
function initNotifications(){renderNotifyButton();if('serviceWorker' in navigator){navigator.serviceWorker.register('/sw.js').catch((e)=>console.warn('SW registration failed',e))}}
function renderNotifyButton(){$('notifyButton').textContent=state.notifyEnabled?'◆':'◇';$('notifyButton').title=state.notifyEnabled?'Уведомления включены':'Уведомления выключены'}
async function toggleNotifications(){
  if(!('Notification' in window)){
    const ua=navigator.userAgent||''
    const ios=/iPhone|iPad|iPod/.test(ua)||(/Macintosh/.test(ua)&&'ontouchend' in document)
    toast(ios?'На iOS уведомления работают только после «Поделиться → На экран „Домой"»':'Уведомления не поддерживаются этим браузером',4200)
    return
  }
  if(Notification.permission==='denied'){
    state.notifyEnabled=false;localStorage.setItem(NOTIFY_KEY,'0');renderNotifyButton()
    toast('Уведомления запрещены — включите их в настройках браузера для этого сайта',4200)
    return
  }
  if(Notification.permission!=='granted'){
    const permission=await Notification.requestPermission()
    if(permission!=='granted'){state.notifyEnabled=false;localStorage.setItem(NOTIFY_KEY,'0');toast('Разрешение на уведомления не выдано');renderNotifyButton();return}
    state.notifyEnabled=true;localStorage.setItem(NOTIFY_KEY,'1');renderNotifyButton();notifyUser('OpenCode','Уведомления включены','notify-enabled')
    return
  }
  state.notifyEnabled=!state.notifyEnabled
  localStorage.setItem(NOTIFY_KEY,state.notifyEnabled?'1':'0')
  if(state.notifyEnabled)notifyUser('OpenCode','Уведомления включены','notify-enabled')
  renderNotifyButton()
}
async function notifyUser(title,body,tag,sessionID){if(!state.notifyEnabled||!('Notification'in window)||Notification.permission!=='granted')return;const data=sessionID?{url:`/#/session/${encodeURIComponent(sessionID)}`}:{url:'/'};const options={body,tag,data};try{const registration=await serviceWorkerReady();if(registration?.showNotification){await registration.showNotification(title,options);return}}catch{}try{new Notification(title,options)}catch{}}
function updateBadge(){const count=state.running.size;try{if(count)navigator.setAppBadge?.(count);else navigator.clearAppBadge?.()}catch{}}

function ensureAssistant(id){let m=state.context.find((x)=>x.id===id);if(m)return m;m={id,type:'assistant',content:[],time:{created:Date.now()}};state.context.push(m);return m}
function ensurePart(message,type,ordinal=0){let p=(message.content||[]).filter((x)=>x.type===type)[ordinal];if(p)return p;p={type,text:''};message.content||=[];message.content.push(p);return p}
function ensureTool(message,data){let p=(message.content||[]).find((x)=>x.type==='tool'&&x.id===data.id);if(p)return p;p={type:'tool',id:data.id,name:data.name||'tool',state:{status:'streaming',input:''},time:{created:Date.now()}};message.content||=[];message.content.push(p);return p}
function markStarted(sessionID,label='running'){if(!sessionID||(state.sessions.length&&!state.sessions.some((session)=>session.id===sessionID)))return;invalidateRunSync();state.running.set(sessionID,{status:label,since:Date.now()});statusPolling.wake();rateLimitPolling.wake();renderSessions();if(state.selected?.id===sessionID)renderHeader();updateBadge()}
function markFinished(sessionID,kind='готово'){if(!sessionID)return;invalidateRunSync();const wasRunning=state.running.has(sessionID);state.running.delete(sessionID);renderSessions();if(state.selected?.id===sessionID)renderHeader();updateBadge();const session=state.sessions.find((s)=>s.id===sessionID);if(wasRunning&&(document.hidden||state.selected?.id!==sessionID))notifyUser(`OpenCode: ${kind}`,sessionTitle(session),`done-${sessionID}`,sessionID);if(wasRunning||queueFor(sessionID).length)void flushQueue(sessionID)}
function handleEvent(payload){
  window.dispatchEvent(new CustomEvent('custom-opencode:event',{detail:payload}))
  if(['session.created','session.deleted'].includes(payload.type))sessionPolling.wake()
  const data=payload.data||payload.properties||{}, sid=data.sessionID||data.session?.id
  if(['session.execution.started','session.busy','session.status.running'].includes(payload.type))markStarted(sid,payload.type)
  if(payload.type==='session.status'){const type=data.status?.type||data.type;if(['busy','retry','running'].includes(type))markStarted(sid,type);if(type==='idle')markFinished(sid,'готово')}
  if(['session.execution.succeeded','session.idle'].includes(payload.type))markFinished(sid,'готово')
  if(['message.part.delta','message.part.updated','message.updated'].includes(payload.type)&&sid===state.selected?.id)scheduleContextReload(140)
  if(payload.type==='session.execution.failed')markFinished(sid,'ошибка')
  if(payload.type==='session.execution.interrupted')markFinished(sid,'остановлено')
  if(!state.selected||sid!==state.selected.id)return
  let message,part
  switch(payload.type){
    case'session.step.started':ensureAssistant(data.assistantMessageID);scheduleMessageRender();break
    case'session.reasoning.started':ensurePart(ensureAssistant(data.assistantMessageID),'reasoning',data.ordinal||0);scheduleMessageRender();break
    case'session.reasoning.delta':part=ensurePart(ensureAssistant(data.assistantMessageID),'reasoning',data.ordinal||0);part.text+=(data.delta||'');scheduleMessageRender();break
    case'session.reasoning.ended':part=ensurePart(ensureAssistant(data.assistantMessageID),'reasoning',data.ordinal||0);part.text=data.text||part.text;scheduleMessageRender();break
    case'session.text.started':ensurePart(ensureAssistant(data.assistantMessageID),'text',data.ordinal||0);scheduleMessageRender();break
    case'session.text.delta':part=ensurePart(ensureAssistant(data.assistantMessageID),'text',data.ordinal||0);part.text+=(data.delta||'');scheduleMessageRender();break
    case'session.text.ended':part=ensurePart(ensureAssistant(data.assistantMessageID),'text',data.ordinal||0);part.text=data.text||part.text;scheduleMessageRender();break
    case'session.tool.input.started':ensureTool(ensureAssistant(data.assistantMessageID),data);scheduleMessageRender();break
    case'session.tool.input.delta':part=ensureTool(ensureAssistant(data.assistantMessageID),data);part.state.input+=(data.delta||'');scheduleMessageRender();break
    case'session.tool.called':part=ensureTool(ensureAssistant(data.assistantMessageID),data);part.state={status:'running',input:data.input||{},metadata:{}};scheduleMessageRender();break
    case'session.tool.progress':part=ensureTool(ensureAssistant(data.assistantMessageID),data);part.state.metadata=data.metadata||{};scheduleMessageRender();break
    case'session.tool.success':part=ensureTool(ensureAssistant(data.assistantMessageID),data);part.state={status:'completed',input:part.state.input||data.input||{},content:data.content||[],metadata:data.metadata||{}};scheduleMessageRender();break
    case'session.tool.failed':part=ensureTool(ensureAssistant(data.assistantMessageID),data);part.state={status:'error',input:part.state.input||{},error:data.error,content:data.content||[]};scheduleMessageRender();break
    case'session.inbox.delivered':case'session.execution.succeeded':case'session.execution.failed':case'session.execution.interrupted':scheduleContextReload(120);break
    default: if(payload.type.startsWith('session.'))scheduleContextReload(450)
  }
}
function connectEventStream(){eventSource?.close();eventSource=api.connectEvents(handleEvent,()=>{if(state.running.size)toast('Переподключение к event stream…',1200)})}
const pollStatusesCoalesced=createRefreshCoalescer()
async function pollStatuses(force=false){if(force)statusSyncGeneration+=1;return pollStatusesCoalesced(async()=>{const statusGeneration=++statusSyncGeneration;const statuses=await api.sessionStatuses();if(statusGeneration!==statusSyncGeneration)return;if(syncRunStatuses(statuses)){renderSessions();renderHeader();updateBadge()}},force)}
const statusPolling=createAdaptivePoller({run:pollStatuses,isActive:()=>state.running.size>0,activeDelay:15000,idleDelay:30000,isVisible:()=>!document.hidden})
const rateLimitPolling=createAdaptivePoller({run:pollRateLimit,isActive:()=>state.running.size>0,activeDelay:10000,idleDelay:30000,isVisible:()=>!document.hidden})
const sessionPolling=createAdaptivePoller({run:()=>loadSessions({background:true}),isActive:()=>state.running.size>0,activeDelay:60000,idleDelay:60000,isVisible:()=>!document.hidden})

function setupPullRefresh(){
  const el=$('messages')
  if(!el)return
  const SWIPE_DISTANCE=18,HOLD_FLOOR=12,HOLD_DURATION=320,SWIPE_PROGRESS=0.18,MIN_REFRESH_TIME=420
  const indicator=document.createElement('div')
  indicator.className='pull-refresh'
  indicator.setAttribute('role','status')
  indicator.setAttribute('aria-live','polite')
  indicator.setAttribute('aria-atomic','true')
  indicator.hidden=true
  indicator.innerHTML='<svg class="pull-refresh-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle class="pull-refresh-track" cx="12" cy="12" r="9" pathLength="1"></circle><circle class="pull-refresh-progress" cx="12" cy="12" r="9" pathLength="1"></circle><path class="pull-refresh-arrow" d="M17.7 6.3A8 8 0 1 0 20 12M17.7 2.8v3.5h-3.5"></path><path class="pull-refresh-check" d="m7.2 12.4 3.1 3.1 6.7-7"></path></svg><span class="pull-refresh-label">Тяните вверх для обновления</span>'
  document.body.append(indicator)
  const label=indicator.querySelector('.pull-refresh-label')
  let gesture=null,holdFrame=0,refreshing=false,hideTimer=null
  const atBottom=()=>el.scrollHeight-el.clientHeight-el.scrollTop<=4
  const place=()=>{const rect=el.getBoundingClientRect();indicator.style.left=`${rect.left+rect.width/2}px`;indicator.style.top=`${Math.max(rect.top+8,rect.bottom-52)}px`}
  const show=(next,ratio=0)=>{
    place()
    indicator.hidden=false
    indicator.style.setProperty('--pull-progress',String(Math.max(0,Math.min(1,ratio))))
    if(indicator.dataset.state!==next){indicator.dataset.state=next;label.textContent=next==='pulling'?'Тяните вверх для обновления':next==='refreshing'?'Обновление сессии…':next==='done'?'Сессия обновлена':'Удерживайте для обновления'}
  }
  const hide=()=>{clearTimeout(hideTimer);indicator.hidden=true;indicator.dataset.state='idle';indicator.style.removeProperty('--pull-progress')}
  const stopHold=()=>{if(holdFrame)cancelAnimationFrame(holdFrame);holdFrame=0;if(gesture)gesture.holdAt=null}
  const cancelGesture=()=>{stopHold();gesture=null;if(!refreshing)hide()}
  const refreshData=async()=>{
    if(refreshing)return
    refreshing=true
    const sessionID=gesture?.sessionID
    stopHold();gesture=null;show('refreshing',1)
    const started=performance.now()
    await Promise.allSettled([loadSessions(),sessionID?loadContext({force:true}):Promise.resolve()])
    const remaining=MIN_REFRESH_TIME-(performance.now()-started)
    if(remaining>0)await new Promise((resolve)=>setTimeout(resolve,remaining))
    if(state.selected?.id===sessionID){show('done',1);hideTimer=setTimeout(()=>{refreshing=false;hide()},700)}
    else{refreshing=false;hide()}
  }
  const updateHold=(now)=>{
    if(!gesture?.holdAt||refreshing)return
    if(state.selected?.id!==gesture.sessionID){cancelGesture();return}
    const ratio=Math.min(1,(now-gesture.holdAt)/HOLD_DURATION)
    show('holding',SWIPE_PROGRESS+(1-SWIPE_PROGRESS)*ratio)
    if(ratio>=1){void refreshData();return}
    holdFrame=requestAnimationFrame(updateHold)
  }
  const startHold=()=>{
    if(gesture?.holdAt)return
    gesture.holdAt=performance.now()
    show('holding',SWIPE_PROGRESS)
    holdFrame=requestAnimationFrame(updateHold)
  }
  el.addEventListener('touchstart',(event)=>{
    if(event.touches.length!==1){cancelGesture();return}
    if(refreshing||!state.selected||!atBottom())return
    const touch=event.touches[0]
    clearTimeout(hideTimer)
    gesture={identifier:touch.identifier,startX:touch.clientX,startY:touch.clientY,holdAt:null,sessionID:state.selected.id}
  },{passive:true})
  el.addEventListener('touchmove',(event)=>{
    if(!gesture||refreshing)return
    if(event.touches.length!==1){cancelGesture();return}
    const touch=Array.from(event.touches).find((item)=>item.identifier===gesture.identifier)
    if(!touch){cancelGesture();return}
    if(state.selected?.id!==gesture.sessionID){cancelGesture();return}
    const dx=touch.clientX-gesture.startX,distance=gesture.startY-touch.clientY
    if(Math.abs(dx)>10&&Math.abs(dx)>Math.abs(distance)*1.2){cancelGesture();return}
    if(distance>0&&event.cancelable)event.preventDefault()
    if(distance < -6||!atBottom()){cancelGesture();return}
    if(distance<=6){stopHold();hide();return}
    if(gesture.holdAt&&distance>=HOLD_FLOOR)return
    if(distance>=SWIPE_DISTANCE){startHold();return}
    stopHold();show('pulling',distance/SWIPE_DISTANCE*SWIPE_PROGRESS)
  },{passive:false})
  el.addEventListener('touchend',()=>{
    if(!gesture||refreshing)return
    cancelGesture()
  },{passive:true})
  el.addEventListener('touchcancel',cancelGesture,{passive:true})
  window.addEventListener('resize',()=>{if(!indicator.hidden)place()})
}
function autosizeInput(){const el=$('input');el.style.height='auto';el.style.height=Math.min(el.scrollHeight,180)+'px'}

function bindEvents(){
  $('sessions').addEventListener('click',event=>{const button=event.target.closest('[data-session-shortcut]');if(button)selectSession(button.dataset.sessionShortcut)})
   $('newSession').addEventListener('click',()=>openProjectDialog('create'))
  $('chooseProject').addEventListener('click',()=>openProjectDialog('create'));$('refresh').addEventListener('click',()=>{loadSessions();if(state.selected)loadContext({force:true})});$('search').addEventListener('input',renderSessions)
  $('menu').addEventListener('click',()=> $('sidebar').classList.toggle('open'));$('sessionActions').addEventListener('click',()=>openSessionActions());$('modelButton').addEventListener('click',()=>{renderModelChoices();$('modelDialog').showModal();$('modelSearch').focus()});$('modelSearch').addEventListener('input',renderModelChoices);$('modelChoices').addEventListener('click',(event)=>{const fav=event.target.closest?.('[data-fav]');if(fav){event.preventDefault();event.stopPropagation();const key=fav.dataset.fav;favorites.has(key)?favorites.delete(key):favorites.add(key);saveJson(FAV_KEY,[...favorites]);renderModelChoices();return}const button=event.target.closest?.('[data-model][data-provider]');if(!button)return;$('modelDialog').close();changeModel({id:button.dataset.model,providerID:button.dataset.provider})})
  $('variantSelect').addEventListener('change',(e)=>{const ref=activeModelRef();if(!ref)return;const model={id:ref.id,providerID:ref.providerID};if(e.target.value)model.variant=e.target.value;changeModel(model)})
  $('form').addEventListener('submit',sendMessage);$('stop').addEventListener('click',stopSelected);$('input').addEventListener('input',()=>{notePromptInput();autosizeInput();scheduleDraftSave()});$('input').addEventListener('keydown',(e)=>{if(e.key==='ArrowUp'&&navigatePromptHistory(-1,e)){e.preventDefault();return}if(e.key==='ArrowDown'&&navigatePromptHistory(1,e)){e.preventDefault();return}if(e.key==='Enter'&&!e.shiftKey&&!e.isComposing&&!window.matchMedia('(max-width: 760px)').matches){e.preventDefault();$('form').requestSubmit()}})
  $('attachButton').addEventListener('click',()=> $('fileInput').click());$('fileInput').addEventListener('change',(e)=>{addFiles(e.target.files);e.target.value=''});$('input').addEventListener('paste',(e)=>{const files=[...(e.clipboardData?.items||[])].filter((i)=>i.kind==='file').map((i)=>i.getAsFile()).filter(Boolean);if(files.length){e.preventDefault();addFiles(files)}})
  document.querySelectorAll('[data-delivery]').forEach((b)=>b.addEventListener('click',()=>{state.deliveryMode=b.dataset.delivery;renderRunControls()}));$('gitButton').addEventListener('click',openGitDialog);$('usageButton').addEventListener('click',()=>{$('usageDialog').showModal()});$('notifyButton').addEventListener('click',toggleNotifications)
  $('renameForm').addEventListener('submit',(e)=>{e.preventDefault();renameCurrent()});document.querySelectorAll('[data-close]').forEach((b)=>b.addEventListener('click',()=>$(b.dataset.close).close()));document.querySelectorAll('dialog').forEach((d)=>d.addEventListener('click',(e)=>{if(e.target===d)d.close()}))
  const messagesView=$('messages')
  const maybeLoadOlderFromUser=()=>{
    if(!historyPaginationIntent||initialMessageScrollSession===state.selected?.id||messagesView.scrollTop>80)return
    historyPaginationIntent=false
    clearTimeout(historyPaginationIntentTimer)
    historyPaginationIntentTimer=0
    void loadOlderContext()
  }
  const armHistoryPagination=()=>{
    historyPaginationIntent=true
    clearTimeout(historyPaginationIntentTimer)
    historyPaginationIntentTimer=setTimeout(()=>{historyPaginationIntent=false;historyPaginationIntentTimer=0},1000)
    if(initialMessageScrollSession===state.selected?.id){
      initialMessageScrollSession=null
      initialMessageScrollObserver?.disconnect()
      initialMessageScrollObserver=null
    }
    requestAnimationFrame(maybeLoadOlderFromUser)
  }
  messagesView.addEventListener('wheel',(event)=>{
    if(event.deltaY<0)armHistoryPagination()
  },{passive:true})
  messagesView.addEventListener('pointerdown',(event)=>{
    const rect=messagesView.getBoundingClientRect()
    if(event.pointerType==='mouse'&&event.clientX>=rect.right-20)armHistoryPagination()
  },{passive:true})
  messagesView.addEventListener('keydown',(event)=>{
    if(['ArrowUp','PageUp','Home'].includes(event.key))armHistoryPagination()
  })
  messagesView.addEventListener('touchstart',(event)=>{
    if(event.touches.length!==1){historyPaginationTouch=null;return}
    const touch=event.touches[0]
    historyPaginationTouch={identifier:touch.identifier,x:touch.clientX,y:touch.clientY,armed:false}
  },{passive:true})
  messagesView.addEventListener('touchmove',(event)=>{
    const gesture=historyPaginationTouch
    if(!gesture||gesture.armed||event.touches.length!==1)return
    const touch=Array.from(event.touches).find((item)=>item.identifier===gesture.identifier)
    if(!touch){historyPaginationTouch=null;return}
    const dx=touch.clientX-gesture.x,dy=touch.clientY-gesture.y
    if(dy>=12&&Math.abs(dx)<=Math.abs(dy)){gesture.armed=true;armHistoryPagination()}
    else if(Math.abs(dx)>12){historyPaginationTouch=null}
  },{passive:true})
  messagesView.addEventListener('touchend',()=>{historyPaginationTouch=null},{passive:true})
  messagesView.addEventListener('touchcancel',()=>{historyPaginationTouch=null},{passive:true})
  messagesView.addEventListener('scroll',()=>{maybeLoadOlderFromUser();updateScrollToBottomButton()},{passive:true})
  $('scrollToBottom').addEventListener('click',scrollMessagesToBottom)
  $('messagesInner').addEventListener('click',(e)=>{const copyCode=e.target.closest('.copy-code');if(copyCode){navigator.clipboard.writeText(copyCode.closest('.code-block').querySelector('code')?.textContent||'');copyCode.textContent='Скопировано';setTimeout(()=>copyCode.textContent='Копировать',900);return}const copy=e.target.closest('[data-copy-message]');if(copy){navigator.clipboard.writeText(messagePlainText(state.context[Number(copy.dataset.copyMessage)])||'');toast('Сообщение скопировано');return}const fork=e.target.closest('[data-fork-message]');if(fork){forkAtMessage(fork.dataset.forkMessage)}})
  window.addEventListener('hashchange',()=>{const id=sessionIdFromHash();if(id&&state.selected?.id!==id)selectSession(id,{push:false});else if(!id&&state.selected)clearSelection()});window.addEventListener('beforeunload',saveDraftNow)
  document.addEventListener('visibilitychange',()=>{if(!document.hidden){pollStatuses(true);pollRateLimit(true);statusPolling.reschedule();rateLimitPolling.reschedule();sessionPolling.wake();if(state.selected&&!isRunning(state.selected.id)){loadContext({force:false})}}})
}

async function initialize(){
  state.clientConfig=await api.getClientConfig();bindEvents();attachDragHandlers();setupPullRefresh();await initNotifications();connectEventStream();await loadSessions({selectHash:true});if(!state.selected){restoreDraft();await loadDraftControls()}statusPolling.start({immediate:false});rateLimitPolling.start();sessionPolling.start({immediate:false});autosizeInput();renderHeader()
}
initialize().catch((error)=>{console.error(error);toast(`Ошибка запуска: ${error.message}`,7000)})
