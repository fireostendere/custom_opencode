// Metadata only: never retain URLs with query values, bodies, headers or credentials.
const rows=[]
let sequence=0
const nativeFetch=window.fetch.bind(window)
function routeName(path){return path.replace(/\/(?:ses_|msg_|part_|t_)[^/]+/g,'/:id')}
function caller(){
  const frames=String(new Error().stack||'').split('\n')
  for(const frame of frames){
    const match=frame.match(/\/([^/\s():]+\.js):(\d+):\d+/)
    if(match&&!['network-diagnostics.js','auth-ui.js','api.js'].includes(match[1])&&!frame.includes('window.fetch'))return `${match[1]}:${match[2]}`
  }
  return 'fetch'
}
window.fetch=async(input,options)=>{
  const url=new URL(typeof input==='string'||input instanceof URL?String(input):input.url,location.href)
  if(url.origin!==location.origin||!/^\/(api\/|client-)/.test(url.pathname))return nativeFetch(input,options)
  const row={id:++sequence,method:String(options?.method||input?.method||'GET').toUpperCase(),route:routeName(url.pathname),queryKeys:[...url.searchParams.keys()],source:caller(),status:'pending',ms:0}
  rows.push(row);if(rows.length>200)rows.shift()
  const start=performance.now()
  try{const response=await nativeFetch(input,options);row.status=response.status;return response}
  catch(error){row.status=error.name==='AbortError'?'cancelled':'network-error';throw error}
  finally{row.ms=Math.round(performance.now()-start);render()}
}
function snapshot(){return {version:1,limit:200,total:sequence,requests:rows.map(row=>({...row,queryKeys:[...row.queryKeys]}))}}
function render(){
  const dialog=document.getElementById('networkDialog')
  if(!dialog?.open)return
  const groups=new Map()
  const onlyErrors=document.getElementById('networkErrors').checked
  for(const row of rows){
    const failed=typeof row.status==='number'?row.status>=400:row.status==='network-error'
    if(onlyErrors&&!failed)continue
    const key=[row.method,row.route,row.queryKeys.join(','),row.source].join(' ')
    const group=groups.get(key)||{...row,count:0,errors:0,totalMs:0}
    group.count++;group.errors+=Number(failed);group.totalMs+=row.ms;group.status=row.status
    groups.set(key,group)
  }
  document.getElementById('networkSummary').textContent=`С начала загрузки: ${sequence}. Показаны последние ${rows.length} API-запросов. Статика и содержимое запросов не записываются.`
  const body=document.getElementById('networkRows');body.replaceChildren()
  for(const row of [...groups.values()].sort((a,b)=>b.count-a.count)){
    const tr=document.createElement('tr')
    for(const value of [row.count,`${row.method} ${row.route}${row.queryKeys.length?' ? '+row.queryKeys.join(', '):''}`,row.source,row.status,row.errors,`${Math.round(row.totalMs/row.count)} мс`]){
      const td=document.createElement('td');td.textContent=String(value);tr.append(td)
    }
    body.append(tr)
  }
}
function init(){
  const button=document.createElement('button');button.type='button';button.id='networkButton';button.textContent='Диагностика'
  document.querySelector('.sidebar-account-actions').append(button)
  const dialog=document.createElement('dialog');dialog.id='networkDialog'
  dialog.innerHTML='<div class="modal large"><div class="modal-head"><h3>Сеть · диагностика</h3><button type="button" id="networkClose" aria-label="Закрыть">×</button></div><p id="networkSummary" role="status"></p><div class="network-actions"><label><input type="checkbox" id="networkErrors"> Только ошибки</label><button type="button" id="networkClear">Очистить</button><button type="button" id="networkExport">Скачать отчёт</button></div><div class="network-table"><table><thead><tr><th>Кол-во</th><th>Запрос</th><th>Источник</th><th>Последний статус</th><th>Ошибки</th><th>Среднее время</th></tr></thead><tbody id="networkRows"></tbody></table></div><p>Источник — вызывающий файл и строка. 404 может означать проверку совместимости; 400/403 — ограничение проекта; 5xx — сбой сервера. Полный запрос смотри в DevTools.</p></div>'
  document.body.append(dialog)
  button.addEventListener('click',()=>{dialog.showModal();render()})
  document.getElementById('networkClose').onclick=()=>dialog.close()
  document.getElementById('networkErrors').onchange=render
  document.getElementById('networkClear').onclick=()=>{rows.length=0;sequence=0;render()}
  document.getElementById('networkExport').onclick=()=>{
    const url=URL.createObjectURL(new Blob([JSON.stringify(snapshot(),null,2)],{type:'application/json'}))
    const a=document.createElement('a');a.href=url;a.download='opencode-network.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000)
  }
}
window.CustomOpenCodeNetwork={snapshot,open:()=>document.getElementById('networkButton').click()}
init()
