const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
class Node {
  constructor(tag,text=''){this.tag=tag;this.value='';this.children=[];this.handlers={};this.dataset={};this.style={};this.isConnected=true;this._text=text;this.disabled=false;}
  append(...nodes){this.children.push(...nodes.map(n=>typeof n==='string'?new Node('text',n):n));}
  prepend(n){this.children.unshift(n);}
  replaceChildren(...nodes){this.children=[];this._text='';this.append(...nodes);}
  set textContent(s){this._text=String(s);this.children=[];}
  get textContent(){return this._text+this.children.map(n=>n.textContent).join('');}
  setAttribute(k,v){this[k]=v;}
  addEventListener(k,f){this.handlers[k]=f;}
  click(){this.handlers.click?.({stopPropagation(){}});}
}
const all=n=>[n,...n.children.flatMap(all)];
async function settle(check){for(let i=0;i<200;i++){if(check())return;await new Promise(setImmediate);}throw new Error('workflow did not settle');}
function setup({read='ཚཁགངཅ',failed=false,hook=()=>{},pieces=1,legibility='clear'}={}) {
  let text='ཀཁགངཅ';let applied=0;let edited=0;let active=true;let page='page';const calls=[],providers=[];
  const document={createElement:tag=>new Node(tag),createTextNode:text=>new Node('text',text),body:new Node('body')};
  const sandbox={window:{LineVisionProofread:require('../line-vision-proofread.js')},document,crypto:require('node:crypto').webcrypto,AbortController,AbortSignal,Blob,FormData,URL,Date,JSON,console,queueMicrotask,setTimeout,
    MutationObserver:class{observe(){}disconnect(){}},indexedDB:{open(){const r={};queueMicrotask(()=>r.onerror());return r;}},
    fetch:async(url,opts)=>{
      if(!opts)return {blob:async()=>new Blob(['pixels'])};
      calls.push(url);providers.push(opts.body.get('provider'));hook(url,()=>{text='ཀཁགངཆ';});
      if(url.endsWith('proofread-prepare'))return {ok:true,json:async()=>({version:2,source_sha256:require('node:crypto').createHash('sha256').update('page').digest('hex'),rows:1,region_image:'data:x',region_bbox:{x:0,y:0,width:1,height:1},fragments:Array.from({length:pieces},(_,i)=>({id:`r1s${i+1}`,row:1,segment:i+1,image:'data:x',context_image:'data:x',sha256:'hash',pixels:{width:900,height:100},page_bbox:{x:0,y:0,width:1,height:1},first:true,last:true}))})};
      if(failed&&opts.body.get('provider')==='gemini')return {ok:false,status:503,json:async()=>({error:'provider unavailable'})};
      if(url.endsWith('proofread-read'))return {ok:true,json:async()=>({version:2,image_sha256:'hash',text:read,legibility,model:'mock'})};
      return {ok:true,json:async()=>({version:2,image_sha256:'hash',verdicts:JSON.parse(opts.body.get('candidates')).map(o=>({id:o.id,verdict:'supports_proposal',reason:'mock visual evidence'}))})};
    }};
  vm.runInNewContext(fs.readFileSync(require.resolve('../visual-proofread-panel.js'),'utf8'),sandbox);
  const panel=sandbox.window.VisualProofreadPanel.create({contextKey:'test',getCandidates:()=>[{id:'bdrc',label:'BDRC',text}],getImage:async()=>new Blob([page]),bbox:{x:0,y:0,width:1,height:1},endpoint:'http://test/line-review',models:{gemini:['mock'],qwen:['mock']},isCurrent:()=>active,onLocate(){},onEdit(){edited++;},onApply(c,v){text=v;applied++;}});
  const click=label=>{const node=all(panel).find(n=>n.tag==='button'&&n.textContent===label);assert.ok(node,label);assert.equal(node.disabled,false);node.click();};
  return {panel,click,calls,providers,get edited(){return edited;},get applied(){return applied;},setActive:v=>{active=v;},changeImage:()=>{page='changed page';}};
}
test('one blind image reading marks differences and guides manual editing',async()=>{
  const s=setup();s.click('准备原图 / 重新分行');await settle(()=>s.panel.textContent.includes('已准备'));
  s.click('全行逐字复核');await settle(()=>s.panel.dataset.reviewState==='complete');
  assert.equal(s.calls.filter(c=>c.endsWith('proofread-read')).length,1);
  assert.equal(s.calls.filter(c=>c.endsWith('proofread-verify')).length,0);
  assert.ok(all(s.panel).some(n=>n.className==='visual-difference'));
  assert.equal(all(s.panel).some(n=>n.className==='visual-model-error'),false);
  assert.equal(s.applied,0);s.click('修改此识别');assert.equal(s.edited,1);
});
test('one provider failure never promotes red or completion',async()=>{
  const s=setup({failed:true});s.click('准备原图 / 重新分行');await settle(()=>s.panel.textContent.includes('已准备'));
  s.click('全行逐字复核');await settle(()=>s.panel.dataset.reviewState==='error');
  assert.ok(s.panel.textContent.includes('0/1'));assert.equal(all(s.panel).some(n=>n.className==='visual-model-error'),false);
});
test('candidate edit during a request prevents stale verification and adoption',async()=>{
  const s=setup({hook:(url,change)=>{if(url.endsWith('proofread-read'))change();}});
  s.click('准备原图 / 重新分行');await settle(()=>s.panel.textContent.includes('已准备'));s.click('全行逐字复核');await settle(()=>s.panel.dataset.reviewState==='error');
  assert.equal(s.calls.filter(c=>c.endsWith('proofread-verify')).length,0);assert.equal(s.applied,0);
});
test('full mode traverses all image fragments even for unanimous candidates',async()=>{
  const s=setup({read:'ཀཁགངཅ',pieces:2});s.click('准备原图 / 重新分行');await settle(()=>s.panel.textContent.includes('已准备'));s.click('全行逐字复核');await settle(()=>s.panel.dataset.reviewState==='complete');
  assert.equal(s.calls.filter(c=>c.endsWith('proofread-read')).length,2);assert.ok(s.panel.textContent.includes('2/2'));assert.equal(s.applied,0);
});

test('changed original image blocks new requests and stale evidence',async()=>{
  const s=setup();s.click('准备原图 / 重新分行');await settle(()=>s.panel.textContent.includes('已准备'));
  s.changeImage();s.click('全行逐字复核');await settle(()=>s.panel.textContent.includes('原页图像已改变'));
  assert.equal(s.calls.filter(c=>c.endsWith('proofread-read')).length,0);assert.equal(s.applied,0);
  const t=setup();t.click('准备原图 / 重新分行');await settle(()=>t.panel.textContent.includes('已准备'));
  t.click('全行逐字复核');await settle(()=>t.panel.dataset.reviewState==='complete');
  t.changeImage();t.click('全行逐字复核');await settle(()=>t.panel.textContent.includes('原页图像已改变'));
  assert.equal(t.applied,0);
});

test('model reports unclear image never promotes a difference to red',async()=>{
  const s=setup({legibility:'partial'});s.click('准备原图 / 重新分行');await settle(()=>s.panel.textContent.includes('已准备'));
  s.click('全行逐字复核');await settle(()=>s.panel.dataset.reviewState==='complete');
  assert.equal(all(s.panel).some(n=>n.className==='visual-model-error'),false);assert.equal(all(s.panel).some(n=>n.tag==='button'&&n.textContent==='按建议修改'),false);assert.equal(s.applied,0);
});

test('one primary action prepares image and checks all fragments with advanced details collapsed',async()=>{
  const s=setup({pieces:2,read:'ཀཁགངཅ'});
  assert.ok(s.panel.textContent.includes('核对这一行'));
  s.click('核对这一行');await settle(()=>s.panel.dataset.reviewState==='complete');
  assert.equal(s.calls.filter(c=>c.endsWith('proofread-prepare')).length,1);
  assert.equal(s.calls.filter(c=>c.endsWith('proofread-read')).length,2);
  assert.equal(all(s.panel).filter(n=>n.className==='visual-coverage').length,0);
  assert.ok(all(s.panel).some(n=>n.className==='visual-advanced' && !n.open));
  assert.ok(all(s.panel).some(n=>n.className==='visual-evidence-details' && !n.open));
});

test('recheck reruns a completed row rather than doing nothing',async()=>{
  const s=setup({read:'ཀཁགངཅ'});
  s.click('核对这一行');await settle(()=>s.panel.dataset.reviewState==='complete');
  assert.equal(s.calls.filter(c=>c.endsWith('proofread-read')).length,1);
  s.click('重新核对');await settle(()=>s.calls.filter(c=>c.endsWith('proofread-read')).length===2);
  assert.equal(s.calls.filter(c=>c.endsWith('proofread-read')).length,2);
});

test('another vision provider is optional and still makes one image call',async()=>{
  const s=setup();const select=all(s.panel).find(n=>n.tag==='select');select.value='qwen:mock';
  s.click('核对这一行');await settle(()=>s.panel.dataset.reviewState==='complete');
  assert.deepEqual(s.providers.filter(Boolean),['qwen']);
  assert.equal(s.calls.filter(c=>c.endsWith('proofread-verify')).length,0);
});
test('unlocatable image reading leaves OCR text unmarked',async()=>{
  const s=setup({read:'ཨཨཨཨཨཨཨཨ'});
  s.click('核对这一行');await settle(()=>s.panel.dataset.reviewState==='complete');
  assert.ok(s.panel.textContent.includes('无法可靠定位'));
  assert.equal(all(s.panel).some(n=>n.className==='visual-difference'),false);
  assert.equal(all(s.panel).some(n=>n.tag==='button'&&n.textContent==='手动修改此识别'),true);
});
