const CACHE='custom-opencode-web-v2'
const STATIC_RE=/\.(?:js|css|webmanifest|png|svg|ico)$/
self.addEventListener('install',()=>self.skipWaiting())
self.addEventListener('activate',(event)=>event.waitUntil((async()=>{for(const key of await caches.keys())if(key!==CACHE)await caches.delete(key);await self.clients.claim()})()))
self.addEventListener('fetch',(event)=>{
  const req=event.request;if(req.method!=='GET')return
  const url=new URL(req.url);if(url.origin!==location.origin||url.pathname.startsWith('/api/')||url.pathname==='/client-config.json')return
  if(url.pathname==='/'||url.pathname==='/index.html'||STATIC_RE.test(url.pathname))event.respondWith((async()=>{
    const cache=await caches.open(CACHE);const cached=await cache.match(req)
    const network=fetch(req).then((res)=>{if(res.ok)cache.put(req,res.clone());return res}).catch(()=>cached)
    return cached||network
  })())
})
self.addEventListener('notificationclick',(event)=>{event.notification.close();event.waitUntil((async()=>{const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});const url=event.notification.data?.url||'/';if(clients[0]){await clients[0].focus();if('navigate'in clients[0])await clients[0].navigate(url);return}await self.clients.openWindow(url)})())})
