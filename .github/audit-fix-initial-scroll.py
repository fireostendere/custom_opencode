#!/usr/bin/env python3
from pathlib import Path

app = Path("app/app.js")
text = app.read_text(encoding="utf-8")

state_old = "let applyingPromptHistory = false\n"
state_new = "let applyingPromptHistory = false\nlet initialMessageScrollSession = null\n"
if "let initialMessageScrollSession = null\n" not in text:
    if state_old not in text:
        raise SystemExit("initial scroll state insertion point not found")
    text = text.replace(state_old, state_new, 1)

render_variants = [
'''  else if(bottom){
    const sessionID=state.selected?.id
    initialMessageScrollSession=sessionID
    const settleBottom=()=>{if(state.selected?.id!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
    settleBottom()
    const frames=new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    const fonts=document.fonts?.ready?document.fonts.ready.catch(()=>{}):Promise.resolve()
    Promise.all([frames,fonts]).then(()=>{settleBottom();if(initialMessageScrollSession===sessionID)initialMessageScrollSession=null})
  }
''',
'''  else if(bottom){
    const sessionID=state.selected?.id
    initialMessageScrollSession=sessionID
    const settleBottom=()=>{if(state.selected?.id!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
    settleBottom()
    const frames=new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    const fonts=document.fonts?.ready?document.fonts.ready.catch(()=>{}):Promise.resolve()
    Promise.all([frames,fonts]).then(()=>{settleBottom();if(initialMessageScrollSession===sessionID)initialMessageScrollSession=null;maybeLoadOlderContext()})
  }
''',
'''  else if(bottom){
    const sessionID=state.selected?.id
    const settleBottom=()=>{if(state.selected?.id!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
    settleBottom()
    requestAnimationFrame(()=>requestAnimationFrame(settleBottom))
    if(document.fonts?.ready)document.fonts.ready.then(settleBottom).catch(()=>{})
  }
''',
]
render_final = '''  else if(bottom){
    const sessionID=state.selected?.id
    initialMessageScrollSession=sessionID
    const settleBottom=()=>{if(state.selected?.id!==sessionID||initialMessageScrollSession!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
    settleBottom()
    const frames=new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    const fonts=document.fonts?.ready?document.fonts.ready.catch(()=>{}):Promise.resolve()
    Promise.all([frames,fonts]).then(settleBottom)
  }
'''
if render_final not in text:
    for block in render_variants:
        if block in text:
            text = text.replace(block, render_final, 1)
            break
    else:
        raise SystemExit("initial bottom convergence block not found")

maybe_variants = [
'''function maybeLoadOlderContext() {
  if(initialMessageScrollSession===state.selected?.id)return
  const view=$('messages'),cache=state.selected&&state.contextCache.get(state.selected.id)
  if(cache?.hasMore&&view&&view.scrollHeight<=view.clientHeight+8)void loadOlderContext()
}
''',
'''function maybeLoadOlderContext() {
  const view=$('messages'),cache=state.selected&&state.contextCache.get(state.selected.id)
  if(cache?.hasMore&&view&&view.scrollHeight<=view.clientHeight+8)void loadOlderContext()
}
''',
]
for block in maybe_variants:
    if block in text:
        text = text.replace(block, "", 1)
text = text.replace("    if(!cache.complete&&state.selected?.id===id)maybeLoadOlderContext()\n", "")
if "maybeLoadOlderContext" in text:
    raise SystemExit("hidden auto-pagination reference remains")

scroll_variants = [
"  $('messages').addEventListener('scroll',()=>{const view=$('messages');if(initialMessageScrollSession!==state.selected?.id&&view.scrollTop<=80)void loadOlderContext();updateScrollToBottomButton()},{passive:true})\n",
"  $('messages').addEventListener('scroll',()=>{if($('messages').scrollTop<=80)void loadOlderContext();updateScrollToBottomButton()},{passive:true})\n",
]
scroll_final = '''  const messagesView=$('messages')
  const armHistoryPagination=()=>{if(initialMessageScrollSession===state.selected?.id)initialMessageScrollSession=null}
  messagesView.addEventListener('wheel',armHistoryPagination,{passive:true})
  messagesView.addEventListener('touchstart',armHistoryPagination,{passive:true})
  messagesView.addEventListener('pointerdown',armHistoryPagination,{passive:true})
  messagesView.addEventListener('scroll',()=>{if(initialMessageScrollSession!==state.selected?.id&&messagesView.scrollTop<=80)void loadOlderContext();updateScrollToBottomButton()},{passive:true})
'''
if scroll_final not in text:
    for block in scroll_variants:
        if block in text:
            text = text.replace(block, scroll_final, 1)
            break
    else:
        raise SystemExit("message scroll pagination handler not found")

app.write_text(text, encoding="utf-8")

test = Path("scripts/web-fixture-e2e.py")
t = test.read_text(encoding="utf-8")
initial_old = '''    page.wait_for_function("document.querySelectorAll('#messages .message').length === 80")
    assert page.locator("#messages").evaluate("el => el.scrollHeight - el.clientHeight - el.scrollTop < 4"), "initial session viewport must start at the newest messages"
'''
initial_new = '''    page.wait_for_function("document.querySelectorAll('#messages .message').length === 80")
    page.wait_for_function("document.querySelector('#messages').scrollHeight - document.querySelector('#messages').clientHeight - document.querySelector('#messages').scrollTop < 4")
    assert page.locator("#messages").evaluate("el => el.scrollHeight - el.clientHeight - el.scrollTop < 4"), "initial session viewport must start at the newest messages"
'''
if initial_new not in t:
    if initial_old not in t:
        raise SystemExit("initial viewport assertion block not found")
    t = t.replace(initial_old, initial_new, 1)
loop_old = '''    for expected in (160, 240, 241):
        page.evaluate("document.querySelector('#messages').scrollTop = 0")
        page.wait_for_function(f"document.querySelectorAll('#messages .message').length === {expected}")
'''
loop_new = '''    for expected in (160, 240, 241):
        page.locator("#messages").hover()
        page.mouse.wheel(0, -100000)
        page.wait_for_function("document.querySelector('#messages').scrollTop <= 1")
        page.wait_for_function(f"document.querySelectorAll('#messages .message').length === {expected}")
'''
if loop_new not in t:
    if loop_old not in t:
        raise SystemExit("history pagination loop not found")
    t = t.replace(loop_old, loop_new, 1)
test.write_text(t, encoding="utf-8")
