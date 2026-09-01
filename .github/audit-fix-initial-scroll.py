#!/usr/bin/env python3
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f"{label} block not found")
    return text.replace(old, new, 1)


app = Path("app/app.js")
text = app.read_text(encoding="utf-8")
text = replace_once(
    text,
    "const SESSION_ORDER_KEY = 'opencode:web:session-order-v1'\n",
    "const SESSION_TREE_KEY = 'opencode:web:session-tree-v1'\n",
    "session tree key",
)
text = replace_once(
    text,
    "function projectOrder() { return loadJson(PROJECT_ORDER_KEY, []) }\nfunction sessionOrder() { return loadJson(SESSION_ORDER_KEY, {}) }\nfunction orderIndex(order, value) { const index=order.indexOf(value); return index<0?Number.MAX_SAFE_INTEGER:index }\n",
    "function projectOrder() { return loadJson(PROJECT_ORDER_KEY, []) }\nfunction sessionTreeExpanded() { return new Set(loadJson(SESSION_TREE_KEY, [])) }\nfunction orderIndex(order, value) { const index=order.indexOf(value); return index<0?Number.MAX_SAFE_INTEGER:index }\nfunction compareSessions(a,b) { return Number(meta(b.id).pinned)-Number(meta(a.id).pinned)||sessionTime(b)-sessionTime(a)||sessionTitle(a).localeCompare(sessionTitle(b),'ru',{sensitivity:'base',numeric:true}) }\n",
    "session sorting helpers",
)
old_manual = '''function sessionIdsForProject(projectID) {
  const order=sessionOrder()[projectID]||[]
  return state.sessions.filter((session)=>projectInfo(session).key===projectID)
    .sort((a,b)=>orderIndex(order,a.id)-orderIndex(order,b.id)||Number(meta(b.id).pinned)-Number(meta(a.id).pinned)||sessionTime(b)-sessionTime(a))
    .map((session)=>session.id)
}
function reorderSessions(sourceID,targetID,targetProject,after=false) {
  const value=sessionOrder(),ids=sessionIdsForProject(targetProject)
  const sourceIndex=ids.indexOf(sourceID),targetIndex=ids.indexOf(targetID)
  if(sourceIndex<0||targetIndex<0||sourceID===targetID)return
  ids.splice(sourceIndex,1)
  const insertion=ids.indexOf(targetID)+(after?1:0)
  ids.splice(Math.max(0,insertion),0,sourceID)
  value[targetProject]=ids;saveJson(SESSION_ORDER_KEY,value);renderSessions()
}
function appendSessionToOrder(sessionID,targetProject,targetID='',after=false) {
  const value=sessionOrder(),ids=sessionIdsForProject(targetProject).filter((id)=>id!==sessionID)
  const index=targetID?ids.indexOf(targetID):-1
  const insertion=index<0?ids.length:index+(after?1:0)
  ids.splice(insertion,0,sessionID);value[targetProject]=ids;saveJson(SESSION_ORDER_KEY,value)
}
'''
text = replace_once(text, old_manual, "", "manual session ordering")
text = replace_once(
    text,
    "    const unique = new Map(sessions.filter((s)=>!s?.parentID).map((s)=>[s.id,s]))\n    state.sessions = [...unique.values()].sort((a,b)=>sessionTime(b)-sessionTime(a))\n",
    "    const unique = new Map(sessions.map((s)=>[s.id,s]))\n    state.sessions = [...unique.values()].sort(compareSessions)\n",
    "child session retention",
)
old_render = '''function renderSessions() {
  if (state.loading) { $('sessions').innerHTML='<div class="loading">Загрузка сессий…</div>'; return }
  const query = $('search').value.trim().toLowerCase()
  const visible = state.sessions.filter((session)=>{
    const m=meta(session.id)
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
  const savedProjectOrder=projectOrder(),savedSessionOrder=sessionOrder()
  const orderedGroups=[...groups.values()].sort((a,b)=>orderIndex(savedProjectOrder,a.info.key)-orderIndex(savedProjectOrder,b.info.key)||Number(meta(b.items[0]?.id).pinned)-Number(meta(a.items[0]?.id).pinned)||sessionTime(b.items[0])-sessionTime(a.items[0]))
  for(const group of orderedGroups){const order=savedSessionOrder[group.info.key]||[];group.items.sort((a,b)=>orderIndex(order,a.id)-orderIndex(order,b.id)||Number(meta(b.id).pinned)-Number(meta(a.id).pinned)||sessionTime(b)-sessionTime(a))}
  const collapsedProjects = new Set(loadJson(PROJECT_COLLAPSE_KEY, []))
  $('sessions').innerHTML=orderedGroups.map(({info,items})=>`
    <details class="project-group" data-project="${escapeHtml(info.key)}"${collapsedProjects.has(info.key) ? '' : ' open'}>
      <summary class="project" draggable="true" title="${escapeHtml(info.directory)}"><span>${escapeHtml(info.label)}</span><span class="count">${items.length}</span></summary>
      <div class="project-sessions">${items.map((session)=>{
      const running=isRunning(session.id), queued=queueFor(session.id).length, m=meta(session.id)
      return `<div class="session ${state.selected?.id===session.id?'active':''} ${m.pinned?'pinned':''}" draggable="true" data-session-drag="${escapeHtml(session.id)}">
        <button class="session-main" data-session="${escapeHtml(session.id)}">
          <div class="session-title">${escapeHtml(sessionTitle(session))}</div>
          <div class="session-meta">${running?'<span class="run-dot"></span>':''}<span>${running?'Выполняется':timeText(sessionTime(session))}</span>${queued?`<span class="queued">очередь ${queued}</span>`:''}</div>
        </button><button class="session-more" data-session-more="${escapeHtml(session.id)}">•••</button>
      </div>`
      }).join('')}</div>
    </details>`).join('')
  document.querySelectorAll('[data-project]').forEach((group)=>group.addEventListener('toggle',()=>{
    const values=new Set(loadJson(PROJECT_COLLAPSE_KEY, []))
    group.open ? values.delete(group.dataset.project) : values.add(group.dataset.project)
    saveJson(PROJECT_COLLAPSE_KEY, [...values])
  }))
  document.querySelectorAll('[data-session]').forEach((button)=>button.addEventListener('click',()=>selectSession(button.dataset.session)))
  document.querySelectorAll('[data-session-more]').forEach((button)=>button.addEventListener('click',(event)=>{event.stopPropagation();openSessionActions(button.dataset.sessionMore)}))
}
'''
new_render = '''function sessionMatches(session,query) {
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
  const toggle=hasChildren?`<button class="session-tree-toggle" type="button" data-session-tree-toggle="${escapeHtml(session.id)}" aria-expanded="${open?'true':'false'}" aria-label="${open?'Свернуть':'Развернуть'} дочерние диалоги"></button>`:'<span class="session-tree-spacer" aria-hidden="true"></span>'
  const childBody=hasChildren?`<div class="session-children" data-session-children="${escapeHtml(session.id)}"${open?'':' hidden'}>${visibleChildren.map((child)=>renderSessionNode(child,children,expanded,query,depth+1)).join('')}</div>`:''
  return `<div class="session-node${depth?' subagent-node':''}" data-session-node="${escapeHtml(session.id)}" data-session-depth="${depth}"><div class="session ${state.selected?.id===session.id?'active':''} ${m.pinned?'pinned':''}${depth?' subagent':''}"${depth?'':` draggable="true" data-session-drag="${escapeHtml(session.id)}"`}>
    ${toggle}<button class="session-main" data-session="${escapeHtml(session.id)}">
      <div class="session-title">${escapeHtml(sessionTitle(session))}</div>
      <div class="session-meta">${running?'<span class="run-dot"></span>':''}${depth&&agent?`<span class="session-kind">${escapeHtml(agent)}</span>`:''}<span>${running?'Выполняется':timeText(sessionTime(session))}</span>${queued?`<span class="queued">очередь ${queued}</span>`:''}${hasChildren?`<span class="session-child-count">${visibleChildren.length} sub</span>`:''}</div>
    </button><button class="session-more" data-session-more="${escapeHtml(session.id)}">•••</button>
  </div>${childBody}</div>`
}
function renderSessions() {
  if (state.loading) { $('sessions').innerHTML='<div class="loading">Загрузка сессий…</div>'; return }
  const query=$('search').value.trim().toLowerCase(),tree=sessionTree(),roots=tree.roots.filter((session)=>subtreeMatches(session,tree.children,query))
  if (!roots.length) { $('sessions').innerHTML='<div class="empty">Сессий не найдено.</div>'; return }
  const groups=new Map()
  for(const session of roots){const info=projectInfo(session);if(!groups.has(info.key))groups.set(info.key,{info,items:[]});groups.get(info.key).items.push(session)}
  for(const group of groups.values())group.items.sort(compareSessions)
  const savedProjectOrder=projectOrder()
  const orderedGroups=[...groups.values()].sort((a,b)=>orderIndex(savedProjectOrder,a.info.key)-orderIndex(savedProjectOrder,b.info.key)||sessionTime(b.items[0])-sessionTime(a.items[0])||a.info.label.localeCompare(b.info.label,'ru',{sensitivity:'base',numeric:true}))
  const collapsedProjects=new Set(loadJson(PROJECT_COLLAPSE_KEY, [])),expanded=sessionTreeExpanded()
  $('sessions').innerHTML=orderedGroups.map(({info,items})=>`<details class="project-group" data-project="${escapeHtml(info.key)}"${collapsedProjects.has(info.key)?'':' open'}><summary class="project" draggable="true" title="${escapeHtml(info.directory)}"><span>${escapeHtml(info.label)}</span><span class="count">${items.length}</span></summary><div class="project-sessions">${items.map((session)=>renderSessionNode(session,tree.children,expanded,query)).join('')}</div></details>`).join('')
  document.querySelectorAll('[data-project]').forEach((group)=>group.addEventListener('toggle',()=>{const values=new Set(loadJson(PROJECT_COLLAPSE_KEY, []));group.open?values.delete(group.dataset.project):values.add(group.dataset.project);saveJson(PROJECT_COLLAPSE_KEY,[...values])}))
  document.querySelectorAll('[data-session-tree-toggle]').forEach((button)=>button.addEventListener('click',(event)=>{event.preventDefault();event.stopPropagation();const id=button.dataset.sessionTreeToggle,body=document.querySelector(`[data-session-children="${CSS.escape(id)}"]`),values=sessionTreeExpanded(),open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',`${open?'Свернуть':'Развернуть'} дочерние диалоги`);if(body)body.hidden=!open;open?values.add(id):values.delete(id);saveJson(SESSION_TREE_KEY,[...values])}))
  document.querySelectorAll('[data-session]').forEach((button)=>button.addEventListener('click',()=>selectSession(button.dataset.session)))
  document.querySelectorAll('[data-session-more]').forEach((button)=>button.addEventListener('click',(event)=>{event.stopPropagation();openSessionActions(button.dataset.sessionMore)}))
}
'''
text = replace_once(text, old_render, new_render, "session tree renderer")
text = replace_once(
    text,
    '''  if(sourceInfo.key===targetProject){
    if(targetSession)reorderSessions(sourceSession,targetSession.dataset.sessionDrag,targetProject,after)
    else appendSessionToOrder(sourceSession,targetProject,'',after)
    return
  }
''',
    '''  if(sourceInfo.key===targetProject)return
''',
    "same-project manual reorder",
)
text = replace_once(
    text,
    "  appendSessionToOrder(created.id,targetProject,targetSession?.dataset.sessionDrag||'',after)\n  renderSessions()\n",
    "  renderSessions()\n",
    "post-transfer manual order",
)
app.write_text(text, encoding="utf-8")

styles = Path("app/styles.css")
s = styles.read_text(encoding="utf-8")
needle = ".session-more{width:32px;background:transparent;color:var(--muted);padding:0}"
addition = needle + ".project-group>summary.project{list-style:none;cursor:pointer;user-select:none}.project-group>summary.project::-webkit-details-marker{display:none}.project-group>summary.project::after{content:'›';margin-left:auto;font-size:18px;color:var(--muted);transform:rotate(0deg);transition:transform .14s ease}.project-group[open]>summary.project::after{transform:rotate(90deg)}.session-node{min-width:0}.session-tree-toggle,.session-tree-spacer{flex:0 0 26px;width:26px;align-self:stretch}.session-tree-toggle{display:grid;place-items:center;background:transparent;color:var(--muted);padding:0;border-radius:6px}.session-tree-toggle::before{content:'›';font-size:17px;line-height:1;transition:transform .14s ease}.session-tree-toggle[aria-expanded=\"true\"]::before{transform:rotate(90deg)}.session-tree-spacer{display:block}.session-children{margin-left:17px;padding-left:9px;border-left:1px solid var(--line)}.session.subagent .session-main{padding-top:7px;padding-bottom:7px}.session.subagent .session-title{font-size:13px}.session-kind,.session-child-count{color:#8fb9ad}.session-child-count{font-size:10px}"
if addition not in s:
    if needle not in s:
        raise SystemExit("session style insertion point not found")
    s = s.replace(needle, addition, 1)
mobile_old = "@media(max-width:900px){.header-chip{display:none}}@media(max-width:760px){.sidebar{position:fixed;z-index:8;inset:0 auto 0 0;transform:translateX(-100%);transition:transform .18s;box-shadow:8px 0 35px #000a}.sidebar.open{transform:none}.menu{display:block}.header{padding:0 7px}.messages{padding:18px 11px}.composer-wrap{padding:8px 10px 12px}.message{grid-template-columns:28px minmax(0,1fr);gap:8px}.avatar{width:26px;height:26px}.message-actions{opacity:1}.composer-meta{align-items:flex-start;flex-direction:column}.controls{width:100%}.delivery{align-self:flex-end}}"
mobile_new = "@media(max-width:900px){.header-chip{display:none}}@media(max-width:760px){.sidebar{position:fixed;z-index:8;inset:0 auto 0 0;transform:translateX(-100%);transition:transform .18s;box-shadow:8px 0 35px #000a}.sidebar.open{transform:none}.menu{display:block}.header{padding:0 7px}.messages{padding:18px 11px}.composer-wrap{padding:8px 10px 12px}.message{grid-template-columns:28px minmax(0,1fr);gap:8px}.avatar{width:26px;height:26px}.message-actions{opacity:1}.composer-meta{align-items:flex-start;flex-direction:column}.controls{width:100%}.delivery{align-self:flex-end}.session-tree-toggle,.session-tree-spacer{flex-basis:24px;width:24px}.session-children{margin-left:12px;padding-left:6px}}"
s = replace_once(s, mobile_old, mobile_new, "mobile session tree styles")
styles.write_text(s, encoding="utf-8")

advanced = Path("app/advanced-features.js")
a = advanced.read_text(encoding="utf-8")
old_scroll = '''  if (wasOpen) details.forEach((detail) => { detail.open = true })
  const sessionID = state.sessionID
  const revision = state.orchestrationRevision
  requestAnimationFrame(() => {
    if (state.sessionID !== sessionID || state.orchestrationRevision !== revision || state.orchestrationRenderRevision !== renderRevision || host.hidden) return
    restoreScrollState(host.querySelector('.plan-panel-body'), planScroll)
    restoreScrollState(host.querySelector('.orchestration-nodes'), nodesScroll)
    restoreScrollState($('messages'), conversation)
  })
'''
new_scroll = '''  if (wasOpen) details.forEach((detail) => { detail.open = true })
  restoreScrollState($('messages'), conversation)
  const sessionID = state.sessionID
  const revision = state.orchestrationRevision
  requestAnimationFrame(() => {
    if (state.sessionID !== sessionID || state.orchestrationRevision !== revision || state.orchestrationRenderRevision !== renderRevision || host.hidden) return
    restoreScrollState(host.querySelector('.plan-panel-body'), planScroll)
    restoreScrollState(host.querySelector('.orchestration-nodes'), nodesScroll)
  })
'''
a = replace_once(a, old_scroll, new_scroll, "orchestration conversation scroll")
advanced.write_text(a, encoding="utf-8")

test = Path("scripts/web-fixture-e2e.py")
t = test.read_text(encoding="utf-8")
old_projects = '            self.send_json({"data": [{"id": "proj_fixture", "name": "Fixture", "canonical": project}]})\n'
new_projects = '            self.send_json({"data": [{"id": "proj_fixture", "name": "Fixture", "canonical": project}, {"id": "proj_other", "name": "Other", "canonical": project + "-other"}]})\n'
t = replace_once(t, old_projects, new_projects, "fixture projects")
old_sessions = '''        elif path == "/api/session":
            if "limit=100" in parsed.query:
                FixtureState.session_reads += 1
            self.send_json({"data": [session]})
'''
new_sessions = '''        elif path == "/api/session":
            if "limit=100" in parsed.query:
                FixtureState.session_reads += 1
            older = {**session, "id":"ses_older", "title":"Older root", "time":{"created":1_999_999_999_000,"updated":1_999_999_999_100}}
            child = {**session, "id":"ses_child_reader", "title":"Reader subagent", "parentID":"ses_fixture", "agent":"explore", "time":{"created":2_000_000_000_100,"updated":2_000_000_000_500}}
            nested = {**session, "id":"ses_child_review", "title":"Reviewer nested", "parentID":"ses_child_reader", "agent":"review", "time":{"created":2_000_000_000_200,"updated":2_000_000_000_600}}
            other = {**session, "id":"ses_other", "title":"Other project chat", "projectID":"proj_other", "location":{"directory":project + "-other"}, "time":{"created":2_000_000_000_050,"updated":2_000_000_000_050}}
            self.send_json({"data": [older, child, nested, session, other]})
'''
t = replace_once(t, old_sessions, new_sessions, "fixture session tree")
t = replace_once(
    t,
    '    page.locator("#sessions .session").first.click()\n',
    '    page.locator(\'[data-session="ses_fixture"]\').click()\n',
    "explicit fixture session selection",
)
model_old = '''    model_choices = page.locator("#modelChoices .choice")
    assert model_choices.count() == 1, {
        "count": model_choices.count(),
        "text": page.locator("#modelChoices").inner_text(),
        "search": page.locator("#modelSearch").input_value(),
    }
'''
model_new = '''    assert page.locator('#modelChoices [data-provider="bailian-cli"][data-model="qwen3.8-max"]').count() >= 1
'''
t = replace_once(t, model_old, model_new, "model catalog assertion")
login_marker = '''    login(page, base_url)
    open_session(page)
'''
login_replacement = '''    login(page, base_url)
    fixture_group = page.locator('#sessions .project-group[data-project="proj_fixture"]')
    other_group = page.locator('#sessions .project-group[data-project="proj_other"]')
    assert fixture_group.get_attribute("open") is not None and other_group.get_attribute("open") is not None
    root_titles = fixture_group.locator(':scope > .project-sessions > .session-node > .session [data-session] .session-title').all_inner_texts()
    assert root_titles == ["Fixture session", "Older root"], root_titles
    parent_toggle = fixture_group.locator('[data-session-tree-toggle="ses_fixture"]')
    assert parent_toggle.count() == 1 and parent_toggle.get_attribute("aria-expanded") == "false"
    assert fixture_group.locator('[data-session-children="ses_fixture"]').is_hidden()
    parent_toggle.click()
    assert fixture_group.locator('[data-session-children="ses_fixture"]').is_visible()
    assert fixture_group.locator('[data-session="ses_child_reader"] .session-title').inner_text() == "Reader subagent"
    child_toggle = fixture_group.locator('[data-session-tree-toggle="ses_child_reader"]')
    assert child_toggle.count() == 1 and child_toggle.get_attribute("aria-expanded") == "false"
    child_toggle.click()
    assert fixture_group.locator('[data-session="ses_child_review"] .session-title').inner_text() == "Reviewer nested"
    fixture_group.locator(':scope > summary').click()
    assert fixture_group.get_attribute("open") is None and other_group.get_attribute("open") is not None
    fixture_group.locator(':scope > summary').click()
    open_session(page)
'''
t = replace_once(t, login_marker, login_replacement, "sidebar tree regression")
test.write_text(t, encoding="utf-8")
