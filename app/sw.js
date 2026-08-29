const CACHE='custom-opencode-web-v4'
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
  if(url.origin!==location.origin||url.pathname.startsWith('/api/')||url.pathname.startsWith('/client-'))return
  if(url.pathname==='/'||url.pathname==='/index.html'||STATIC_RE.test(url.pathname))event.respondWith((async()=>{
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

self.addEventListener('notificationclick',(event)=>{event.notification.close();if(event.action==='dismiss')return;event.waitUntil((async()=>{
  const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true})
  const url=event.notification.data?.url||'/'
  if(clients[0]){
    await clients[0].focus()
    if('navigate'in clients[0])await clients[0].navigate(url)
    return
  }
  await self.clients.openWindow(url)
})())})
