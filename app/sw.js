const CACHE='custom-opencode-web-v6'
const STATIC_RE=/\.(?:js|css|webmanifest|png|svg|ico)$/

self.addEventListener('install',()=>self.skipWaiting())
self.addEventListener('activate',(event)=>event.waitUntil((async()=>{
  for(const key of await caches.keys())if(key!==CACHE)await caches.delete(key)
  await self.clients.claim()
})()))

self.addEventListener('fetch',(event)=>{
  const req=event.request
  if(req.method!=='GET')return
  const url=new URL(req.url)
  if(
    url.origin!==location.origin||
    url.pathname.startsWith('/api/')||
    url.pathname.startsWith('/auth/')||
    url.pathname.startsWith('/client-')||
    url.pathname.startsWith('/internal/')
  )return

  // HTML is authentication-sensitive. Never serve a cached app shell after a
  // logout or expired session; only cache immutable-ish static assets.
  if(STATIC_RE.test(url.pathname))event.respondWith((async()=>{
    const cache=await caches.open(CACHE)
    const cached=await cache.match(req)
    try{
      const network=await fetch(req,{cache:'no-cache'})
      if(network.ok)await cache.put(req,network.clone())
      return network
    }catch{
      if(cached)return cached
      throw new Error('offline and no cached asset')
    }
  })())
})

async function runtimeAction(action,data){
  if(!data?.taskID)return false
  const response=await fetch('/client-unified-action.json',{
    method:'POST',
    credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({action,taskID:data.taskID,sessionID:data.sessionID||''}),
  })
  return response.ok
}

async function focusOrOpen(url){
  const windows=await self.clients.matchAll({type:'window',includeUncontrolled:true})
  if(windows[0]){
    await windows[0].focus()
    if('navigate'in windows[0])await windows[0].navigate(url)
    return
  }
  await self.clients.openWindow(url)
}

self.addEventListener('notificationclick',(event)=>{
  event.notification.close()
  if(event.action==='dismiss')return
  event.waitUntil((async()=>{
    const data=event.notification.data||{}
    const url=data.url||'/'
    try{
      if(event.action==='cancel-task'){
        if(await runtimeAction('task.cancel',data))return
      }else if(event.action==='retry-task'){
        if(await runtimeAction('task.retry',data))return
      }
    }catch{}
    await focusOrOpen(url)
  })())
})
