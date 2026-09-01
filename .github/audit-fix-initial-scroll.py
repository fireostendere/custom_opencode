#!/usr/bin/env python3
from pathlib import Path

app = Path("app/app.js")
text = app.read_text(encoding="utf-8")

old = '''  else if(bottom){
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
new = '''  else if(bottom){
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
if new not in text:
    if old not in text:
        raise SystemExit("initial bottom lifecycle block not found")
    text = text.replace(old, new, 1)

app.write_text(text, encoding="utf-8")
