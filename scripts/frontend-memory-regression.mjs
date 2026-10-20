#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'
import vm from 'node:vm'
import { createAdaptivePoller, createRefreshCoalescer } from '../app/refresh-coalescer.js'
import { createDndWatchChip } from '../app/dnd-watch-chip.js'

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..')
const plain=value=>JSON.parse(JSON.stringify(value))
const flush=()=>new Promise(done=>setImmediate(done))
function deferred(){let resolve,reject;const promise=new Promise((done,fail)=>{resolve=done;reject=fail});return{promise,resolve,reject}}
class FixtureEvent {
  constructor(type,options={}){this.type=type;Object.assign(this,options)}
  preventDefault(){this.defaultPrevented=true}
  stopImmediatePropagation(){this.stopped=true}
  stopPropagation(){this.stopped=true}
}
function eventTarget(){
  const listeners=new Map()
  return{
    addEventListener(type,handler,options){if(!listeners.has(type))listeners.set(type,[]);listeners.get(type).push({handler,capture:options===true||options?.capture===true})},
    removeEventListener(type,handler){listeners.set(type,(listeners.get(type)||[]).filter(item=>item.handler!==handler))},
    emit(event,capture){for(const item of listeners.get(event.type)||[]){if(event.stopped)break;if(capture!==undefined&&item.capture!==capture)continue;const result=item.handler(event);if(result?.then)(event.promises||=[]).push(result)}},
    dispatchEvent(event){event.target||=this;this.emit(event);return !event.defaultPrevented},
  }
}

function fixture(){
  const storage=new Map(),elements=new Map(),readers=new Map(),requests=[],historyRequests=[],promptCalls=[]
  let clock=10_000,createdReads=0,autoRead=true,attachmentButtons=[]
  const window=eventTarget(),location={hash:''}
  const document={...eventTarget(),hidden:false,visibilityState:'visible',documentElement:{dataset:{}},querySelector:()=>null}
  function dispatch(target,event){event.target=target;document.emit(event,true);target.emit(event,true);target.emit(event,false);document.emit(event,false);return event}
  function element(id){
    let html='',value=''
    const result={...eventTarget(),id,hidden:false,readOnly:false,disabled:false,dataset:{},style:{},textContent:'',files:[],children:[],scrollTop:0,scrollHeight:100,clientHeight:100,selectionStart:0,selectionEnd:0,
      classList:{add(){},remove(){},toggle(){},contains(){return false}},
      get value(){return value},set value(next){value=next;if(id==='fileInput'&&!next)this.files=[]},
      get innerHTML(){return html},set innerHTML(next){html=next;if(id==='attachments'){attachmentButtons=[...String(next).matchAll(/data-remove-attachment="(\d+)"/g)].map((match)=>{const button=element('remove');button.dataset.removeAttachment=match[1];return button});this.children=attachmentButtons}},
      querySelector:()=>null,querySelectorAll:()=>[],contains:()=>false,closest:()=>null,
      setAttribute(name,value){this[name]=value},removeAttribute(name){delete this[name]},focus(){document.activeElement=this},close(){this.open=false},showModal(){this.open=true},scrollTo(){},setSelectionRange(){},append(){},after(){},before(){},
      click(){return dispatch(this,new FixtureEvent('click'))},requestSubmit(){return dispatch(this,new FixtureEvent('submit'))},
    }
    return result
  }
  document.getElementById=id=>elements.get(id)||(elements.set(id,element(id)),elements.get(id))
  document.querySelectorAll=selector=>selector==='[data-remove-attachment]'?attachmentButtons:[]
  document.createElement=()=>element('created')
  document.body=element('body')
  window.matchMedia=()=>({matches:false,addEventListener(){}})
  class FileReader {
    readAsDataURL(file){
      this.file=file;this.name=file.name;this.readyState=1;createdReads++;readers.set(file.name,this)
      if(file.throwOnRead)throw new Error('fixture synchronous read failure')
      if(autoRead)queueMicrotask(()=>this.complete())
    }
    complete(){
      if(this.readyState!==1)return
      this.result='data:application/octet-stream;base64,'+this.file.bytes.toString('base64')
      this.file=null;this.readyState=2;readers.delete(this.name);this.onload?.()
    }
    fail(){this.error=new Error('fixture read failure');this.file=null;this.readyState=2;readers.delete(this.name);this.onerror?.()}
    abort(){this.aborted=true;this.file=null;this.result=null;this.readyState=2;readers.delete(this.name);this.onabort?.()}
  }
  const api={
    getContextPage(id,options){const item={id,options,...deferred()};historyRequests.push(item);return item.promise},
    async deleteSession(){},async listProjects(){return[]},async listSessions(){return[]},async sessionStatuses(){return{}},
    async hasConversation(){return null},isPromptPending(){return false},async sendPrompt(session,value){promptCalls.push({session,value})},
  }
  const fetch=async(path,options={})=>{requests.push({path,options});return Response.json(path==='/client-send.json'?{ok:true}:{data:[]})}
  const common={window,document,location,api,FileReader,fetch,createAdaptivePoller,createRefreshCoalescer,createDndWatchChip,
    localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,String(value))},navigator:{},
    setTimeout:()=>1,clearTimeout(){},setInterval:()=>1,clearInterval(){},requestAnimationFrame:()=>1,queueMicrotask,
    console,URLSearchParams,CustomEvent:FixtureEvent,Event:FixtureEvent,performance,
    Date:class extends Date{static now(){return clock}},ORCHESTRATED_MODELS:[],
    escapeHtml:value=>String(value??''),renderMarkdown:value=>String(value??''),
  }
  const appContext=vm.createContext({...common})
  let source=readFileSync(resolve(root,'app/app.js'),'utf8').replace(/^import .*$/gm,'')
  const boot=source.lastIndexOf('initialize().catch')
  assert.ok(boot>0,'core entrypoint must be found')
  source=source.slice(0,boot)
  vm.runInContext(source+`
    renderSessions=renderHeader=renderMessages=renderUsage=renderControls=()=>{};
    globalThis.exports={state,bindEvents,clearAttachments,removeAttachment,addFiles,attachmentSnapshot,readAttachments,attachmentReads,sendMessage,selectSession,
      contextCacheFor,loadContext,loadOlderContext,removeSession,clearSelection,handleEvent,loadSessionsNow,
      limit:CONTEXT_CACHE_LIMIT,modelVersions:sessionModelVersions,modelOverrides:sessionModelOverrides,historyProbeQueue,
      draftOf:id=>drafts[id]};
  `,appContext)
  const advancedContext=vm.createContext({...common})
  source=readFileSync(resolve(root,'app/advanced-features.js'),'utf8').replace(/^import .*$/gm,'').replace(/^export /gm,'')
    .replace("if (typeof document !== 'undefined') init()",'')
  vm.runInContext(source+`
    renderAll=renderStatus=renderOrchestration=renderDndWatchDialog=()=>{};
    refreshQueue=refreshOrchestration=refreshPlan=async()=>{};
    globalThis.exports={state,bindEvents,selectSessionState,interceptSubmit};
  `,advancedContext)
  const app=appContext.exports,advanced=advancedContext.exports
  app.bindEvents();advanced.bindEvents()
  function session(id){
    app.clearAttachments();app.state.selected={id};app.state.sessions=[app.state.selected];app.state.context=[];app.state.contextCache.clear();app.state.running.clear()
    advanced.state.sessionID=id;advanced.state.session=app.state.selected;advanced.state.orchestrationRevision++;advanced.state.submitPending=false
    location.hash=`#/session/${id}`;document.getElementById('stop').hidden=true;document.getElementById('input').value=''
  }
  return{app,advanced,api,document,window,location,storage,readers,requests,historyRequests,promptCalls,session,
    get readCount(){return createdReads},set autoRead(value){autoRead=value},advance(){clock++},
    attach(files){const input=document.getElementById('fileInput');input.files=files;return dispatch(input,new FixtureEvent('change'))},
    paste(file){return dispatch(document.getElementById('input'),new FixtureEvent('paste',{clipboardData:{items:[{kind:'file',getAsFile:()=>file}]}}))},
    remove(index){attachmentButtons[index].click()},button:index=>attachmentButtons[index],
    submit(text){document.getElementById('input').value=text;return document.getElementById('form').requestSubmit()},
    posts(){return requests.filter(item=>['/client-send.json','/client-queue.json'].includes(item.path))},
  }
}

const f=fixture(),{app,advanced}=f
const file=(name,size=32)=>({name,type:'application/octet-stream',bytes:randomBytes(size)})
const names=rows=>[...rows].map(item=>item.name)
let passed=0
async function test(name,run){await run();passed++;console.log(`PASS ${name}`)}

await test('attach/remove releases completed reads and data URLs (shared modules)',async()=>{
  f.session('memory');f.autoRead=true
  const baseReads=f.readCount
  global.gc?.();const baseline=process.memoryUsage().heapUsed
  for(let i=0;i<100;i++){
    f.attach([file(`discard-${i}`,256*1024)]);await flush();f.remove(0)
    assert.equal(app.state.attachments.length,0);assert.equal(app.attachmentReads.size,0)
  }
  await flush();global.gc?.();const final=process.memoryUsage().heapUsed
  assert.equal(f.readCount-baseReads,100,'managed composer must not duplicate the native FileReader')
  assert.equal(f.readers.size,0)
  if(global.gc)assert.ok(final-baseline<8*1024*1024,'100 removed files must not retain their 33 MiB of encoded data')
  console.log(`  heap after GC: ${(baseline/1024/1024).toFixed(2)} → ${(final/1024/1024).toFixed(2)} MiB; 100 reads, 0 retained operations`)
})

await test('remove during reading aborts exactly that file; late callback cannot replace its neighbour',async()=>{
  f.session('remove');f.autoRead=false
  f.attach([file('A'),file('B')])
  const first=f.readers.get('A'),late=first.onload,staleButton=f.button(0)
  f.remove(0);assert.equal(first.aborted,true);assert.equal(app.attachmentReads.size,1)
  f.attach([file('C')]);f.readers.get('C').complete();f.readers.get('B').complete()
  first.result='data:stale';late();staleButton.click();await flush()
  assert.deepEqual(names(app.state.attachments),['B','C'])
  assert.deepEqual(names(await app.readAttachments()),['B','C'])
  assert.equal(app.attachmentReads.size,0)
  assert.ok(app.state.attachments.every(item=>item.uri!=='data:stale'))
})

await test('managed submit waits for shared reads, excludes removed file and sends only once',async()=>{
  f.session('managed');f.autoRead=false
  const count=f.posts().length,coreCount=f.promptCalls.length
  f.attach([file('remove'),file('keep')]);const event=f.submit('with pending files')
  await flush();assert.equal(f.posts().length,count);assert.equal(advanced.state.submitPending,true)
  f.remove(0);f.readers.get('keep').complete();await Promise.all(event.promises);await flush()
  assert.equal(f.posts().length,count+1);assert.equal(f.promptCalls.length,coreCount,'capture handler must prevent a second native send')
  const body=JSON.parse(f.posts().at(-1).options.body)
  assert.equal(body.text,'with pending files');assert.deepEqual(body.files.map(item=>item.name),['keep'])
  assert.deepEqual(Object.keys(body.files[0]).sort(),['mime','name','uri'],'internal read state must not cross the API')
  assert.equal(app.state.attachments.length,0);assert.equal(app.attachmentReads.size,0)
  assert.equal(advanced.state.submitPending,false);assert.equal(f.document.getElementById('input').readOnly,false)
  f.submit('');await flush();assert.equal(f.posts().length,count+1,'empty composer must not send')
})

await test('managed cleanup preserves a file added after the send snapshot, including its pending read',async()=>{
  f.session('managed-later');f.autoRead=false
  f.attach([file('managed-first')]);const event=f.submit('first batch')
  f.attach([file('managed-later')]);f.readers.get('managed-first').complete();await Promise.all(event.promises)
  assert.deepEqual(JSON.parse(f.posts().at(-1).options.body).files.map(item=>item.name),['managed-first'])
  assert.deepEqual(names(app.state.attachments),['managed-later']);assert.equal(app.attachmentReads.size,1)
  f.readers.get('managed-later').complete();await flush()
  assert.deepEqual(names(await app.readAttachments()),['managed-later'])
})

await test('removing the only pending file cancels a file-only submit without an empty POST',async()=>{
  f.session('file-only');f.autoRead=false
  const count=f.posts().length
  f.attach([file('only')]);const event=f.submit('');f.remove(0)
  await Promise.all(event.promises);assert.equal(f.posts().length,count);assert.equal(advanced.state.submitPending,false)
})

await test('session change cancels pending reads and a pending managed send',async()=>{
  f.session('old');f.autoRead=false
  const count=f.posts().length
  f.attach([file('old-file')]);const reader=f.readers.get('old-file'),late=reader.onload
  const event=f.submit('must stay in old session')
  app.clearSelection({saveDraft:false});await Promise.all(event.promises)
  assert.equal(reader.aborted,true);assert.equal(app.attachmentReads.size,0);assert.equal(f.posts().length,count)
  assert.equal(advanced.state.sessionID,null)
  f.session('new');f.attach([file('new-file')]);f.readers.get('new-file').complete();reader.result='data:old';late();await flush()
  assert.deepEqual(names(await app.readAttachments()),['new-file']);assert.equal(f.posts().length,count)
})

await test('reselecting the same session cancels a pending managed send and restores its text',async()=>{
  f.session('managed-reselect');f.autoRead=false
  const count=f.posts().length
  f.attach([file('cancelled-file')]);const reader=f.readers.get('cancelled-file')
  const event=f.submit('keep this unsent text')
  await app.selectSession('managed-reselect',{waitForDetails:false})
  await Promise.all(event.promises)
  assert.equal(reader.aborted,true);assert.equal(app.attachmentReads.size,0)
  assert.equal(f.posts().length,count,'a cancelled composer must not send its text without its files')
  assert.equal(f.document.getElementById('input').value,'keep this unsent text')
  assert.equal(f.document.getElementById('input').readOnly,false);assert.equal(advanced.state.submitPending,false)
})

await test('a cancelled managed send preserves the replacement draft and attachment batch',async()=>{
  f.session('managed-reselect-new');f.autoRead=false
  const count=f.posts().length
  f.attach([file('old-batch')]);const event=f.submit('old unsent text')
  const selection=app.selectSession('managed-reselect-new',{waitForDetails:false})
  f.document.getElementById('input').value='new draft'
  f.attach([file('replacement-file')])
  await selection;await Promise.all(event.promises)
  assert.equal(f.posts().length,count);assert.equal(f.document.getElementById('input').value,'new draft')
  assert.deepEqual(names(app.state.attachments),['replacement-file']);assert.equal(app.attachmentReads.size,1)
  f.readers.get('replacement-file').complete();await flush()
  assert.deepEqual(names(await app.readAttachments()),['replacement-file'])
  assert.equal(advanced.state.submitPending,false)
})

await test('clipboard files share the same read; failed reads cannot silently produce a send',async()=>{
  f.session('paste');f.autoRead=false
  const reads=f.readCount,count=f.posts().length
  f.paste(file('bad'));assert.equal(f.readCount,reads+1)
  f.readers.get('bad').fail();await flush();assert.equal(app.attachmentReads.size,0)
  const event=f.submit('file must be present');await Promise.all(event.promises)
  assert.equal(f.posts().length,count);assert.equal(app.state.attachments.length,1)
  f.remove(0);assert.equal(app.state.attachments.length,0)
})

await test('native fallback waits for a file and coalesces a repeated pending submit',async()=>{
  f.session('native');f.autoRead=false;advanced.state.sessionID=null
  const count=f.promptCalls.length
  f.attach([file('native-file')]);const first=f.submit('native pending'),second=f.submit('native pending')
  await flush();assert.equal(f.promptCalls.length,count);assert.equal(f.document.getElementById('input').readOnly,true)
  f.readers.get('native-file').complete();await Promise.all([...(first.promises||[]),...(second.promises||[])])
  assert.equal(f.promptCalls.length,count+1);assert.deepEqual(names(f.promptCalls.at(-1).value.files),['native-file'])
  assert.equal(f.document.getElementById('input').readOnly,false)
})

await test('native send failure restores submitted files once and preserves later reads',async()=>{
  f.session('native-failure');f.autoRead=false;advanced.state.sessionID=null
  const original=f.api.sendPrompt,request=deferred()
  f.api.sendPrompt=(session,value)=>{f.promptCalls.push({session,value});return request.promise}
  f.attach([file('native-first')]);const event=f.submit('restore text')
  f.attach([file('native-later')]);f.readers.get('native-first').complete();await flush()
  assert.deepEqual(names(f.promptCalls.at(-1).value.files),['native-first'])
  assert.deepEqual(names(app.state.attachments),['native-later']);assert.equal(app.attachmentReads.size,1)
  request.reject(new Error('fixture rejected send'));await Promise.all(event.promises);f.api.sendPrompt=original
  assert.deepEqual(names(app.state.attachments),['native-first','native-later'])
  assert.equal(f.document.getElementById('input').value,'restore text');assert.equal(f.document.getElementById('input').readOnly,false)
  f.readers.get('native-later').complete();await flush()
  assert.deepEqual(names(await app.readAttachments()),['native-first','native-later'])
})

await test('a native send failure after switching sessions cannot restore old files or text',async()=>{
  f.session('native-old');f.autoRead=true;advanced.state.sessionID=null
  const original=f.api.sendPrompt,request=deferred()
  f.api.sendPrompt=()=>request.promise
  f.attach([file('native-old-file')]);await flush();const event=f.submit('old text');await flush()
  app.clearSelection({saveDraft:false});f.session('native-new');f.attach([file('native-new-file')]);await flush()
  f.document.getElementById('input').value='new draft'
  request.reject(new Error('fixture late failure'));await Promise.all(event.promises);f.api.sendPrompt=original
  assert.deepEqual(names(await app.readAttachments()),['native-new-file'])
  assert.equal(f.document.getElementById('input').value,'new draft')
})

await test('60 overlapping histories stay within 12 entries before and after completion',async()=>{
  f.session('cache');f.historyRequests.length=0
  const loads=[]
  for(let i=0;i<60;i++){
    app.state.selected={id:`s-${i}`};loads.push(app.loadContext())
    assert.ok(app.state.contextCache.size<=app.limit)
  }
  for(const item of f.historyRequests)item.resolve({messages:Array.from({length:80},(_,i)=>({id:`${item.id}-m-${i}`,type:'assistant',text:`text ${i}`})),complete:true})
  await Promise.all(loads)
  assert.equal(app.state.contextCache.size,12)
  assert.equal([...app.state.contextCache.values()].reduce((sum,item)=>sum+item.messages.length,0),960)
  assert.equal(app.state.context.length,80);assert.ok(app.state.context.every(item=>item.id.startsWith('s-59-')))
})

await test('a cache hit prunes an oversized cache and preserves the selected session',async()=>{
  f.session('hit')
  for(let i=0;i<30;i++)app.state.contextCache.set(`hit-${i}`,{messages:[],loaded:true,loading:false,seenCursors:new Set()})
  app.state.selected={id:'hit-0'};await app.loadContext()
  assert.equal(app.state.contextCache.size,12);assert.ok(app.state.contextCache.has('hit-0'))
})

await test('an evicted history reply cannot overwrite a newly loaded entry with the same session ID',async()=>{
  f.session('stale');f.historyRequests.length=0
  const old=app.loadContext(),oldReply=f.historyRequests.at(-1)
  for(let i=0;i<20;i++){app.state.selected={id:`other-${i}`};app.contextCacheFor(app.state.selected.id)}
  assert.equal(app.state.contextCache.has('stale'),false)
  app.state.selected={id:'stale'};const fresh=app.loadContext(),freshReply=f.historyRequests.at(-1)
  freshReply.resolve({messages:[{id:'fresh',type:'assistant',text:'fresh'}],complete:true});await fresh
  oldReply.resolve({messages:[{id:'old',type:'assistant',text:'stale payload'}],complete:true});await old
  assert.deepEqual(plain(app.state.context.map(item=>item.id)),['fresh'])
  assert.deepEqual(plain(app.state.contextCache.get('stale').messages.map(item=>item.id)),['fresh'])
})

await test('deleting a selected session frees transcript, metadata and drafts; delayed history stays discarded',async()=>{
  f.session('delete');f.historyRequests.length=0
  app.state.actionSession=app.state.selected;app.state.mirrorHistory.set('delete',{updated:1,value:true})
  app.historyProbeQueue.push({id:'delete',entry:{value:null}});app.modelVersions.set('delete',1)
  const loading=app.loadContext(),reply=f.historyRequests.at(-1),entry=app.state.contextCache.get('delete')
  entry.messages=[{id:'old',type:'assistant',text:'retained old transcript'}]
  app.state.context=entry.messages;f.document.getElementById('input').value='deleted draft'
  await app.removeSession(app.state.selected)
  assert.equal(app.state.selected,null);assert.equal(app.state.actionSession,null);assert.equal(app.state.context.length,0)
  assert.equal(app.state.contextCache.has('delete'),false);assert.equal(entry.messages.length,0)
  assert.equal(app.state.mirrorHistory.has('delete'),false);assert.equal(app.modelVersions.has('delete'),false)
  assert.equal(app.historyProbeQueue.some(item=>item.id==='delete'),false);assert.equal(app.draftOf('delete'),undefined)
  reply.resolve({messages:[{id:'late',type:'assistant',text:'late deleted payload'}],complete:true});await loading
  assert.equal(app.state.contextCache.has('delete'),false);assert.equal(entry.messages.length,0);assert.equal(app.state.context.length,0)
})

await test('a session list started before deletion cannot put the removed session back',async()=>{
  f.session('list-delete')
  const listing=deferred(),original=f.api.listSessions;f.api.listSessions=()=>listing.promise
  const loading=app.loadSessionsNow();await app.removeSession(app.state.selected)
  listing.resolve([{id:'list-delete'}]);await loading;f.api.listSessions=original
  assert.equal(app.state.sessions.some(item=>item.id==='list-delete'),false)
})

await test('external session deletion discards an outstanding older-history page',async()=>{
  f.session('external');f.historyRequests.length=0
  const cache=app.contextCacheFor('external')
  Object.assign(cache,{loaded:true,hasMore:true,nextCursor:'older',messages:[{id:'now',type:'assistant',text:'current'}]})
  app.state.context=cache.messages
  const loading=app.loadOlderContext(),reply=f.historyRequests.at(-1)
  app.handleEvent({type:'session.deleted',properties:{info:{id:'external'}}})
  assert.equal(app.state.selected,null);assert.equal(app.state.contextCache.has('external'),false)
  reply.resolve({messages:[{id:'older',type:'assistant',text:'late old history'}],complete:true});await loading
  assert.equal(cache.messages.length,0);assert.equal(app.state.context.length,0)
})

await test('stream updates that arrive during history refresh still win over stale fetched text',async()=>{
  f.session('stream');f.historyRequests.length=0
  const cache=app.contextCacheFor('stream'),message={id:'m-live',type:'assistant',content:[{type:'text',text:'before'}]}
  Object.assign(cache,{messages:[message],loaded:true,hasMore:false});app.state.context=cache.messages
  const loading=app.loadContext({force:true}),reply=f.historyRequests.at(-1)
  f.advance();app.handleEvent({type:'session.text.delta',data:{sessionID:'stream',assistantMessageID:'m-live',delta:' streamed'}})
  reply.resolve({messages:[{id:'m-live',type:'assistant',content:[{type:'text',text:'old page'}]}],complete:true});await loading
  assert.equal(app.state.context[0].content[0].text,'before streamed')
})

console.log(`Frontend memory regression: ${passed} scenarios passed`)
