#!/usr/bin/env python3
from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if old not in text:
        raise SystemExit(f"{label} block not found")
    return text.replace(old, new, 1)


def remove_once(text: str, block: str) -> str:
    return text.replace(block, "", 1) if block in text else text


app = Path("app/app.js")
text = app.read_text(encoding="utf-8")

# Keep the one-shot initial history positioning fix idempotent.
old_select = '''  state.selected=session; state.context=cachedContext?.messages||[]; state.attachments=[]; state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
  resetPromptHistory(id)
  renderAttachments(); renderSessions(); renderHeader(); renderMessages({bottom:true}); restoreDraft(); $('sidebar').classList.remove('open')
'''
new_select = '''  state.selected=session; state.context=cachedContext?.messages||[]; state.attachments=[]; state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
  initialMessageScrollObserver?.disconnect();initialMessageScrollObserver=null;initialMessageScrollSession=id
  resetPromptHistory(id)
  renderAttachments(); renderSessions(); renderHeader(); renderMessages({bottom:true}); restoreDraft(); $('sidebar').classList.remove('open')
'''
text = replace_once(text, old_select, new_select, "select session initial scroll")

old_bottom = '''  else if(bottom){
    const sessionID=state.selected?.id
    initialMessageScrollObserver?.disconnect()
    initialMessageScrollObserver=null
    initialMessageScrollSession=sessionID
    let settling=true, observer=null
    const stopSettling=()=>{
      settling=false
      if(initialMessageScrollObserver===observer){observer?.disconnect();initialMessageScrollObserver=null}
    }
    const settleBottom=()=>{if(!settling||state.selected?.id!==sessionID||initialMessageScrollSession!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
    settleBottom()
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
'''
new_bottom = '''  else if(bottom){
    const sessionID=state.selected?.id,stabilize=initialMessageScrollSession===sessionID
    view.scrollTop=view.scrollHeight
    if(stabilize){
      initialMessageScrollObserver?.disconnect()
      initialMessageScrollObserver=null
      let settling=true,observer=null
      const stopSettling=()=>{
        settling=false
        if(initialMessageScrollSession===sessionID)initialMessageScrollSession=null
        if(initialMessageScrollObserver===observer){observer?.disconnect();initialMessageScrollObserver=null}
      }
      const settleBottom=()=>{if(!settling||state.selected?.id!==sessionID||initialMessageScrollSession!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
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
'''
text = replace_once(text, old_bottom, new_bottom, "renderMessages bottom")

old_clear = '''function clearSelection() {
  saveDraftNow(); state.selected=null;state.context=[];state.attachments=[];state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
'''
new_clear = '''function clearSelection() {
  saveDraftNow();initialMessageScrollObserver?.disconnect();initialMessageScrollObserver=null;initialMessageScrollSession=null; state.selected=null;state.context=[];state.attachments=[];state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
'''
text = replace_once(text, old_clear, new_clear, "clear selection")

# Make ordering stable and explicit: pinned first, then last activity, then creation/title/id.
old_compare = "function compareSessions(a,b) { return Number(meta(b.id).pinned)-Number(meta(a.id).pinned)||sessionTime(b)-sessionTime(a)||sessionTitle(a).localeCompare(sessionTitle(b),'ru',{sensitivity:'base',numeric:true}) }\n"
new_compare = "function sessionCreated(session) { return session?.time?.created || 0 }\nfunction compareSessions(a,b) { return Number(meta(b.id).pinned)-Number(meta(a.id).pinned)||sessionTime(b)-sessionTime(a)||sessionCreated(b)-sessionCreated(a)||sessionTitle(a).localeCompare(sessionTitle(b),'ru',{sensitivity:'base',numeric:true})||String(a?.id||'').localeCompare(String(b?.id||'')) }\n"
text = replace_once(text, old_compare, new_compare, "stable session ordering")

# Remove dead manual-order code left from the pre-tree sidebar implementation.
stale_manual_order = '''function sessionIdsForProject(projectID) {
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
text = remove_once(text, stale_manual_order)

# Store child/subagent sessions under explicit virtual folders instead of mixing them with human chats.
old_node = '''function renderSessionNode(session,children,expanded,query='',depth=0) {
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
'''
new_node = '''function renderSessionNode(session,children,expanded,query='',depth=0) {
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
'''
text = replace_once(text, old_node, new_node, "agent session folders")

old_tree_listener = '''  document.querySelectorAll('[data-session-tree-toggle]').forEach((button)=>button.addEventListener('click',(event)=>{event.preventDefault();event.stopPropagation();const id=button.dataset.sessionTreeToggle,body=document.querySelector(`[data-session-children="${CSS.escape(id)}"]`),values=sessionTreeExpanded(),open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));button.setAttribute('aria-label',`${open?'Свернуть':'Развернуть'} дочерние диалоги`);if(body)body.hidden=!open;open?values.add(id):values.delete(id);saveJson(SESSION_TREE_KEY,[...values])}))
'''
new_tree_listener = '''  document.querySelectorAll('[data-agent-folder]').forEach((folder)=>folder.addEventListener('toggle',()=>{const values=sessionTreeExpanded(),id=folder.dataset.agentFolder;folder.open?values.add(id):values.delete(id);saveJson(SESSION_TREE_KEY,[...values])}))
'''
text = replace_once(text, old_tree_listener, new_tree_listener, "agent folder persistence")

# Explicit message provenance. A user-role message inside a child session is not the human user.
marker = "function renderMessages({anchor=null,bottom=false}={}){\n"
helpers = '''function isAgentSession(session) { return Boolean(session?.parentID||session?.parentSessionID) }
function modelRefLabel(ref) {
  if(!ref)return''
  const value=typeof ref==='string'?{id:ref}:ref
  const id=String(value?.id||value?.modelID||'')
  const provider=String(value?.providerID||value?.provider||'')
  const catalog=state.models.find((model)=>model.id===id&&(!provider||model.providerID===provider))
  const label=String(catalog?.name||id||'')
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
'''
text = replace_once(text, marker, helpers, "message provenance helpers")

old_message_map = '''  inner.innerHTML=state.context.map((message,index)=>{const type=message.type||message.role;const id=message.id||message.messageID||`idx-${index}`;const body=type==='user'?userBody(message):assistantBody(message);return `<article class="message ${type==='user'?'user':'assistant'}" data-message-index="${index}"><div class="avatar">${type==='user'?'Я':'AI'}</div><div class="message-body"><div class="message-head"><span class="message-role">${type==='user'?'Ты':'OpenCode'}</span><span class="message-actions"><button class="mini" data-copy-message="${index}">Copy</button><button class="mini" data-fork-message="${escapeHtml(id)}">Fork</button></span></div>${body}</div></article>`}).join('')
'''
new_message_map = '''  inner.innerHTML=state.context.map((message,index)=>{const type=message.type||message.role;const id=message.id||message.messageID||`idx-${index}`;const body=type==='user'?userBody(message):assistantBody(message);const actor=messagePresentation(message,type),family=type==='user'?'user':'assistant';return `<article class="message ${family} ${actor.origin}" data-message-index="${index}" data-origin="${escapeHtml(actor.origin)}"><div class="avatar">${escapeHtml(actor.avatar)}</div><div class="message-body"><div class="message-head"><span class="message-role">${escapeHtml(actor.role)}</span><span class="message-actions"><button class="mini" data-copy-message="${index}">Copy</button><button class="mini" data-fork-message="${escapeHtml(id)}">Fork</button></span></div>${body}</div></article>`}).join('')
'''
text = replace_once(text, old_message_map, new_message_map, "message provenance rendering")
app.write_text(text, encoding="utf-8")

# Independent Plan / Tools panels; preserve each panel's open state separately.
advanced = Path("app/advanced-features.js")
a = advanced.read_text(encoding="utf-8")
a = replace_once(
    a,
    "  const wasOpen = host.querySelector('details')?.open === true\n",
    "  const panelOpen={plan:host.querySelector('.plan-panel')?.open===true,live:host.querySelector('.live-panel')?.open===true}\n",
    "orchestration panel open state",
)
old_sync = '''  const details = [...host.querySelectorAll('details')]
  const syncPanels = (source) => {
    const open = source.open
    details.forEach((detail) => { if (detail !== source) detail.open = open })
    host.classList.toggle('is-expanded', open)
  }
  details.forEach((detail) => {
    const rememberConversation = () => { detail._conversationScroll = captureScrollState($('messages')) }
    const summary = detail.querySelector('summary')
    summary?.addEventListener('pointerdown', rememberConversation)
    summary?.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') rememberConversation() })
    detail.addEventListener('toggle', () => { syncPanels(detail); restoreScrollState($('messages'), detail._conversationScroll || captureScrollState($('messages'))) })
  })
  if (wasOpen) details.forEach((detail) => { detail.open = true })
'''
new_sync = '''  const details = [...host.querySelectorAll('details')]
  details.forEach((detail) => {
    const rememberConversation = () => { detail._conversationScroll = captureScrollState($('messages')) }
    const summary = detail.querySelector('summary')
    summary?.addEventListener('pointerdown', rememberConversation)
    summary?.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') rememberConversation() })
    detail.addEventListener('toggle', () => { host.classList.toggle('is-expanded',details.some((row)=>row.open));restoreScrollState($('messages'), detail._conversationScroll || captureScrollState($('messages'))) })
  })
  const planPanel=host.querySelector('.plan-panel'),livePanel=host.querySelector('.live-panel')
  if(planPanel)planPanel.open=panelOpen.plan
  if(livePanel)livePanel.open=panelOpen.live
  host.classList.toggle('is-expanded',details.some((detail)=>detail.open))
'''
a = replace_once(a, old_sync, new_sync, "independent orchestration panels")
advanced.write_text(a, encoding="utf-8")

# Visual distinction for agent folders and delegated prompts.
styles = Path("app/styles.css")
s = styles.read_text(encoding="utf-8")
old_children_style = ".session-children{margin-left:17px;padding-left:9px;border-left:1px solid var(--line)}"
new_children_style = old_children_style + ".session-agent-folder{margin:2px 0 5px 25px}.session-agent-folder>summary{list-style:none;display:flex;align-items:center;gap:7px;padding:5px 8px;color:var(--muted);font-size:11px;cursor:pointer;user-select:none}.session-agent-folder>summary::-webkit-details-marker{display:none}.session-agent-folder>summary::before{content:'›';font-size:15px;line-height:1;transition:transform .14s ease}.session-agent-folder[open]>summary::before{transform:rotate(90deg)}.session-agent-folder-summary .count{margin-left:auto;font-size:10px}.session-agent-folder>.session-children{margin-left:6px;padding-left:6px}"
s = replace_once(s, old_children_style, new_children_style, "agent folder styles")
s = replace_once(
    s,
    ".message.assistant .avatar{background:var(--accent)}",
    ".message.assistant .avatar{background:var(--accent)}.message.agent-prompt .avatar{background:#725b24}.message.agent-prompt .message-role{color:#e1c063}.message.agent-response .message-role{color:#8fb9ad}",
    "message provenance styles",
)
s = replace_once(
    s,
    ".session-children{margin-left:12px;padding-left:6px}",
    ".session-children{margin-left:12px;padding-left:6px}.session-agent-folder{margin-left:18px}",
    "mobile agent folder styles",
)
styles.write_text(s, encoding="utf-8")

# Extend the real-browser fixture for provenance, virtual folders and independent mobile panels.
test = Path("scripts/web-fixture-e2e.py")
t = test.read_text(encoding="utf-8")
old_child_backend = '''        elif path == "/api/session/ses_fixture":
            self.send_json({"data": session})
        elif path == "/api/session/ses_fixture/context":
'''
new_child_backend = '''        elif path == "/api/session/ses_fixture":
            self.send_json({"data": session})
        elif path == "/api/session/ses_child_reader":
            child = {**session, "id":"ses_child_reader", "title":"Reader subagent", "parentID":"ses_fixture", "agent":"explore", "time":{"created":2_000_000_000_100,"updated":2_000_000_000_500}}
            self.send_json({"data": child})
        elif path == "/api/session/ses_child_reader/message":
            rows = [
                {"info":{"id":"child_assistant","role":"assistant","time":{"created":2_000_000_000_102}},"parts":[{"type":"text","text":"Delegated answer"}]},
                {"info":{"id":"child_user","role":"user","time":{"created":2_000_000_000_101}},"parts":[{"type":"text","text":"Delegated request"}]},
            ]
            self.send_json({"data": rows, "cursor":{"next": None}})
        elif path == "/api/session/ses_fixture/context":
'''
t = replace_once(t, old_child_backend, new_child_backend, "child session fixture")

old_tree_test = '''    parent_toggle = fixture_group.locator('[data-session-tree-toggle="ses_fixture"]')
    parent_children = fixture_group.locator('[data-session-children="ses_fixture"]')
    assert parent_toggle.count() == 1
    if parent_toggle.get_attribute("aria-expanded") == "true":
        parent_toggle.click()
    assert parent_toggle.get_attribute("aria-expanded") == "false" and parent_children.is_hidden()
    parent_toggle.click()
    assert parent_toggle.get_attribute("aria-expanded") == "true" and parent_children.is_visible()
    assert fixture_group.locator('[data-session="ses_child_reader"] .session-title').inner_text() == "Reader subagent"
    child_toggle = fixture_group.locator('[data-session-tree-toggle="ses_child_reader"]')
    child_children = fixture_group.locator('[data-session-children="ses_child_reader"]')
    assert child_toggle.count() == 1
    if child_toggle.get_attribute("aria-expanded") == "true":
        child_toggle.click()
    assert child_toggle.get_attribute("aria-expanded") == "false" and child_children.is_hidden()
    child_toggle.click()
    assert child_toggle.get_attribute("aria-expanded") == "true" and child_children.is_visible()
    assert fixture_group.locator('[data-session="ses_child_review"] .session-title').inner_text() == "Reviewer nested"
'''
new_tree_test = '''    parent_folder = fixture_group.locator('[data-agent-folder="ses_fixture"]')
    parent_children = fixture_group.locator('[data-session-children="ses_fixture"]')
    assert parent_folder.count() == 1
    assert "Агентские диалоги" in parent_folder.locator(':scope > summary').inner_text()
    if parent_folder.get_attribute("open") is not None:
        parent_folder.locator(':scope > summary').click()
    assert parent_folder.get_attribute("open") is None and parent_children.is_hidden()
    parent_folder.locator(':scope > summary').click()
    assert parent_folder.get_attribute("open") is not None and parent_children.is_visible()
    assert fixture_group.locator('[data-session="ses_child_reader"] .session-title').inner_text() == "Reader subagent"
    child_folder = fixture_group.locator('[data-agent-folder="ses_child_reader"]')
    child_children = fixture_group.locator('[data-session-children="ses_child_reader"]')
    assert child_folder.count() == 1
    child_folder.locator(':scope > summary').click()
    assert child_folder.get_attribute("open") is not None and child_children.is_visible()
    assert fixture_group.locator('[data-session="ses_child_review"] .session-title').inner_text() == "Reviewer nested"
    fixture_group.locator('[data-session="ses_child_reader"]').click()
    page.wait_for_function("location.hash.startsWith('#/session/ses_child_reader')")
    page.wait_for_function("document.querySelectorAll('#messages .message').length === 2")
    assert page.locator('#messages .message.user').get_attribute('data-origin') == 'agent-prompt'
    assert page.locator('#messages .message.user .message-role').inner_text() == 'Запрос модели/агента → explore'
    assert page.locator('#messages .message.assistant').get_attribute('data-origin') == 'agent-response'
    assert page.locator('#messages .message.assistant .message-role').inner_text().startswith('Агент explore')
'''
t = replace_once(t, old_tree_test, new_tree_test, "agent folder and provenance browser test")

# Return to the human/root conversation after provenance assertions.
t = replace_once(
    t,
    '''    fixture_group.locator(':scope > summary').click()
    assert fixture_group.get_attribute("open") is None and other_group.get_attribute("open") is not None
    fixture_group.locator(':scope > summary').click()
    open_session(page)
''',
    '''    open_session(page)
    fixture_group.locator(':scope > summary').click()
    assert fixture_group.get_attribute("open") is None and other_group.get_attribute("open") is not None
    fixture_group.locator(':scope > summary').click()
    open_session(page)
''',
    "return to root after provenance test",
)

old_panel_test = '''    page.locator("#messages").evaluate("el => el.scrollTop = Math.min(1, Math.max(0, el.scrollHeight - el.clientHeight))")
    conversation_before = page.locator("#messages").evaluate("el => el.scrollTop")
    page.locator(".plan-panel > summary").click()
    page.locator(".plan-panel-body").evaluate("el => { el.scrollTop = Math.max(1, el.scrollHeight - el.clientHeight - 30) }")
'''
new_panel_test = '''    assert not page.locator('.plan-panel').evaluate('el => el.open')
    assert not page.locator('.live-panel').evaluate('el => el.open')
    page.locator("#messages").evaluate("el => el.scrollTop = Math.min(1, Math.max(0, el.scrollHeight - el.clientHeight))")
    conversation_before = page.locator("#messages").evaluate("el => el.scrollTop")
    page.locator(".plan-panel > summary").click()
    assert page.locator('.plan-panel').evaluate('el => el.open')
    assert not page.locator('.live-panel').evaluate('el => el.open')
    page.locator(".plan-panel-body").evaluate("el => { el.scrollTop = Math.max(1, el.scrollHeight - el.clientHeight - 30) }")
'''
t = replace_once(t, old_panel_test, new_panel_test, "desktop independent panels")

old_panel_end = '''    conversation_after = page.locator("#messages").evaluate("el => el.scrollTop")
    assert abs(conversation_after - conversation_before) <= 2, (conversation_before, conversation_after)

    page.click("#logoutButton")
'''
new_panel_end = '''    conversation_after = page.locator("#messages").evaluate("el => el.scrollTop")
    assert abs(conversation_after - conversation_before) <= 2, (conversation_before, conversation_after)
    page.locator('.live-panel > summary').click()
    assert page.locator('.plan-panel').evaluate('el => el.open') and page.locator('.live-panel').evaluate('el => el.open')
    page.locator('.live-panel > summary').click()
    assert page.locator('.plan-panel').evaluate('el => el.open') and not page.locator('.live-panel').evaluate('el => el.open')

    page.click("#logoutButton")
'''
t = replace_once(t, old_panel_end, new_panel_end, "desktop panel independence follow-up")

old_mobile_end = '''    page.wait_for_timeout(600)
    assert page.locator(".pull-refresh").is_hidden(), "pull refresh result did not dismiss"
    context.close()
'''
new_mobile_end = '''    page.wait_for_timeout(600)
    assert page.locator(".pull-refresh").is_hidden(), "pull refresh result did not dismiss"
    page.evaluate("document.documentElement.dataset.modelProfile = 'orchestrated'")
    page.wait_for_function("document.querySelectorAll('.orchestration-plan-list li').length === 48", timeout=5000)
    plan = page.locator('.plan-panel')
    live = page.locator('.live-panel')
    assert not plan.evaluate('el => el.open') and not live.evaluate('el => el.open')
    plan.locator(':scope > summary').click()
    assert plan.evaluate('el => el.open') and not live.evaluate('el => el.open')
    live.locator(':scope > summary').click()
    assert plan.evaluate('el => el.open') and live.evaluate('el => el.open')
    plan.locator(':scope > summary').click()
    assert not plan.evaluate('el => el.open') and live.evaluate('el => el.open')
    context.close()
'''
t = replace_once(t, old_mobile_end, new_mobile_end, "mobile independent panels")
test.write_text(t, encoding="utf-8")
