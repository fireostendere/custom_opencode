#!/usr/bin/env python3
from pathlib import Path

app = Path("app/app.js")
text = app.read_text(encoding="utf-8")

state_old = "let initialMessageScrollSession = null\n"
state_new = "let initialMessageScrollSession = null\nlet initialMessageScrollObserver = null\n"
if "let initialMessageScrollObserver = null\n" not in text:
    if state_old not in text:
        raise SystemExit("initial scroll state not found")
    text = text.replace(state_old, state_new, 1)

render_without_observer = '''  else if(bottom){
    const sessionID=state.selected?.id
    initialMessageScrollSession=sessionID
    const settleBottom=()=>{if(state.selected?.id!==sessionID||initialMessageScrollSession!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
    settleBottom()
    const frames=new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    const fonts=document.fonts?.ready?document.fonts.ready.catch(()=>{}):Promise.resolve()
    Promise.all([frames,fonts]).then(settleBottom)
  }
'''
render_inner_only = '''  else if(bottom){
    const sessionID=state.selected?.id
    initialMessageScrollObserver?.disconnect()
    initialMessageScrollObserver=null
    initialMessageScrollSession=sessionID
    const settleBottom=()=>{if(state.selected?.id!==sessionID||initialMessageScrollSession!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
    settleBottom()
    if('ResizeObserver' in window){
      initialMessageScrollObserver=new ResizeObserver(settleBottom)
      initialMessageScrollObserver.observe(inner)
    }
    const frames=new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    const fonts=document.fonts?.ready?document.fonts.ready.catch(()=>{}):Promise.resolve()
    Promise.all([frames,fonts]).then(settleBottom)
  }
'''
render_final = '''  else if(bottom){
    const sessionID=state.selected?.id
    initialMessageScrollObserver?.disconnect()
    initialMessageScrollObserver=null
    initialMessageScrollSession=sessionID
    const settleBottom=()=>{if(state.selected?.id!==sessionID||initialMessageScrollSession!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
    settleBottom()
    if('ResizeObserver' in window){
      initialMessageScrollObserver=new ResizeObserver(settleBottom)
      initialMessageScrollObserver.observe(inner)
      initialMessageScrollObserver.observe(view)
    }
    const frames=new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    const fonts=document.fonts?.ready?document.fonts.ready.catch(()=>{}):Promise.resolve()
    Promise.all([frames,fonts]).then(settleBottom)
  }
'''
if render_final not in text:
    if render_inner_only in text:
        text = text.replace(render_inner_only, render_final, 1)
    elif render_without_observer in text:
        text = text.replace(render_without_observer, render_final, 1)
    else:
        raise SystemExit("initial bottom block not found")

arm_old = "  const armHistoryPagination=()=>{if(initialMessageScrollSession===state.selected?.id)initialMessageScrollSession=null}\n"
arm_new = '''  const armHistoryPagination=()=>{
    if(initialMessageScrollSession!==state.selected?.id)return
    initialMessageScrollSession=null
    initialMessageScrollObserver?.disconnect()
    initialMessageScrollObserver=null
  }
'''
if arm_new not in text:
    if arm_old not in text:
        raise SystemExit("history pagination arm handler not found")
    text = text.replace(arm_old, arm_new, 1)

app.write_text(text, encoding="utf-8")
