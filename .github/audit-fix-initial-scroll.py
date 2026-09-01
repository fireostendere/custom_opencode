#!/usr/bin/env python3
from pathlib import Path

path = Path("app/app.js")
text = path.read_text(encoding="utf-8")

state_old = "let applyingPromptHistory = false\n"
state_new = "let applyingPromptHistory = false\nlet initialMessageScrollSession = null\n"
if "let initialMessageScrollSession = null\n" not in text:
    if state_old not in text:
        raise SystemExit("initial scroll state insertion point not found")
    text = text.replace(state_old, state_new, 1)

render_old = '''  else if(bottom){
    const sessionID=state.selected?.id
    const settleBottom=()=>{if(state.selected?.id!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
    settleBottom()
    requestAnimationFrame(()=>requestAnimationFrame(settleBottom))
    if(document.fonts?.ready)document.fonts.ready.then(settleBottom).catch(()=>{})
  }
'''
render_new = '''  else if(bottom){
    const sessionID=state.selected?.id
    initialMessageScrollSession=sessionID
    const settleBottom=()=>{if(state.selected?.id!==sessionID)return;view.scrollTop=view.scrollHeight;updateScrollToBottomButton()}
    settleBottom()
    const frames=new Promise((resolve)=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))
    const fonts=document.fonts?.ready?document.fonts.ready.catch(()=>{}):Promise.resolve()
    Promise.all([frames,fonts]).then(()=>{settleBottom();if(initialMessageScrollSession===sessionID)initialMessageScrollSession=null})
  }
'''
if render_new not in text:
    if render_old not in text:
        raise SystemExit("initial bottom convergence block not found")
    text = text.replace(render_old, render_new, 1)

scroll_old = "  $('messages').addEventListener('scroll',()=>{if($('messages').scrollTop<=80)void loadOlderContext();updateScrollToBottomButton()},{passive:true})\n"
scroll_new = "  $('messages').addEventListener('scroll',()=>{const view=$('messages');if(initialMessageScrollSession!==state.selected?.id&&view.scrollTop<=80)void loadOlderContext();updateScrollToBottomButton()},{passive:true})\n"
if scroll_new not in text:
    if scroll_old not in text:
        raise SystemExit("message scroll pagination handler not found")
    text = text.replace(scroll_old, scroll_new, 1)

path.write_text(text, encoding="utf-8")
