#!/usr/bin/env python3
from pathlib import Path

path = Path("app/app.js")
text = path.read_text(encoding="utf-8")
old_select = '''  state.selected=session; state.context=cachedContext?.messages||[]; state.attachments=[]; state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
  resetPromptHistory(id)
  renderAttachments(); renderSessions(); renderHeader(); renderMessages({bottom:true}); restoreDraft(); $('sidebar').classList.remove('open')
'''
new_select = '''  state.selected=session; state.context=cachedContext?.messages||[]; state.attachments=[]; state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
  initialMessageScrollObserver?.disconnect();initialMessageScrollObserver=null;initialMessageScrollSession=id
  resetPromptHistory(id)
  renderAttachments(); renderSessions(); renderHeader(); renderMessages({bottom:true}); restoreDraft(); $('sidebar').classList.remove('open')
'''
if new_select not in text:
    if old_select not in text: raise SystemExit("select session initial scroll block not found")
    text=text.replace(old_select,new_select,1)
old_bottom='''  else if(bottom){
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
new_bottom='''  else if(bottom){
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
if new_bottom not in text:
    if old_bottom not in text: raise SystemExit("renderMessages bottom block not found")
    text=text.replace(old_bottom,new_bottom,1)
old_clear='''function clearSelection() {
  saveDraftNow(); state.selected=null;state.context=[];state.attachments=[];state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
'''
new_clear='''function clearSelection() {
  saveDraftNow();initialMessageScrollObserver?.disconnect();initialMessageScrollObserver=null;initialMessageScrollSession=null; state.selected=null;state.context=[];state.attachments=[];state.agents=[];state.models=[];state.providers=[];state.defaultModel=null
'''
if new_clear not in text:
    if old_clear not in text: raise SystemExit("clear selection block not found")
    text=text.replace(old_clear,new_clear,1)
path.write_text(text,encoding="utf-8")
