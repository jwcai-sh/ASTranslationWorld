/* Original-image evidence workflow; deliberately independent of OCR caches. */
(function (root) {
  'use strict';
  const algorithm = () => root.LineVisionProofread;
  const element = (tag, text, className) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(className)e.className=className; return e; };
  const button = (text,action) => { const e=element('button',text,'ghost-button compact'); e.type='button'; e.addEventListener('click',event=>{event.stopPropagation(); action();}); return e; };
  async function database(key,value) {
    const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('tibetan-visual-evidence',1);r.onupgradeneeded=()=>r.result.createObjectStore('reviews');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
    try { return await new Promise((resolve,reject)=>{ const tx=db.transaction('reviews',value?'readwrite':'readonly');const req=value?tx.objectStore('reviews').put(value,key):tx.objectStore('reviews').get(key);let result;req.onsuccess=()=>{result=req.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error); }); }
    finally {db.close();}
  }
  async function post(endpoint,route,form,signal) {
    const response=await fetch(endpoint.replace(/\/line-review$/,`/${route}`),{method:'POST',body:form,signal:AbortSignal.any([signal,AbortSignal.timeout(210000)])});
    let payload; try {payload=await response.json();} catch {throw new Error(`服务未返回有效结果（HTTP ${response.status}）`);}
    if(!response.ok) throw new Error(payload.error||payload.detail||`HTTP ${response.status}`);
    return payload;
  }
  async function imageForm(piece,provider,model,options) {
    const f=new FormData();f.append('file',await (await fetch(piece.image)).blob(),'detail.png');
    f.append('context',await (await fetch(piece.context_image)).blob(),'context.png');
    f.append('provider',provider);f.append('model',model);
    if(options)f.append('candidates',JSON.stringify(options));return f;
  }
  function create(config) {
    const section=element('section',undefined,'line-vision-proofread visual-proofread-v2');
    section.dataset.reviewState='idle';
    const header=element('div',undefined,'line-vision-header');header.append(element('strong','原图核对','line-vision-heading'));
    const feedback=element('div','核图后只提示待确认的差异。','line-vision-feedback');feedback.setAttribute('role','status');feedback.setAttribute('aria-live','polite');
    const controls=element('div',undefined,'visual-review-controls');
    const advanced=element('details',undefined,'visual-advanced');advanced.append(element('summary','更多选项与核图记录'));
    const selectionSlot=element('div');
    const roster=element('div',undefined,'visual-roster');
    const body=element('div',undefined,'line-vision-results');
    const evidence=element('details',undefined,'visual-evidence-details');
    const evidenceTitle=element('summary','查看原图依据与设置');
    const cacheStatus=element('small','校对记录保存在本机浏览器；可导出备份。','visual-cache-status');
    let prepared=null, report=null, imports=[], controller=null, busy=false, originalBlob=null, sourceSnapshot='', restoreDone=false;
    const selected=new Set();
    const modelLabel=element('label','核图模型');
    const modelSelect=element('select');modelSelect.setAttribute('aria-label','核图模型');
    for(const [provider,label] of [['gemini','Gemini'],['qwen','千问']]) {
      for(const name of config.models[provider]||[]) {
        const option=element('option',`${label} · ${name}`);option.value=`${provider}:${name}`;modelSelect.append(option);
      }
    }
    if(modelSelect.children[0])modelSelect.value=modelSelect.children[0].value;
    modelLabel.append(modelSelect);controls.append(modelLabel);
    const key=`v3:${config.contextKey}`;
    const candidates=()=>[...config.getCandidates(),...imports];
    const fingerprint=()=>JSON.stringify(candidates());
    const live=()=>section.isConnected && config.isCurrent();
    const current=()=>live() && fingerprint()===sourceSnapshot;
    const status=(message,state='idle')=>{feedback.textContent=message;section.dataset.reviewState=state;};
    async function persist() {
      if(!live())return;
      try {await database(key,{version:2,imports,prepared,report,sourceSnapshot,savedAt:new Date().toISOString()});cacheStatus.textContent='校对记录已保存到本机浏览器';}
      catch {cacheStatus.textContent='校对记录保存失败（可能空间不足）；请导出备份，当前结果仍在本页。';}
    }
    async function verifySource(expected=prepared) {
      const blob=await config.getImage();
      const digest=await crypto.subtle.digest('SHA-256',await blob.arrayBuffer());
      const hash=Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join('');
      if(!live())throw new Error('页面已改变');
      if(expected?.source_sha256!==hash)throw new Error('原页图像已改变，旧证据已失效。请重新准备原图。');
      originalBlob=blob;
    }
    function setBusy(value) {busy=value; for(const b of [startButton,prepareButton,quickButton,fullButton,retryButton,importButton])b.disabled=value;modelSelect.disabled=value;stopButton.disabled=!value;}
    function stop() {controller?.abort();status('已停止；已完成片段保留，未完成片段可重试。');}
    const observer=new MutationObserver(()=>{if(!section.isConnected){controller?.abort();observer.disconnect();}});
    queueMicrotask(()=>{if(section.isConnected)observer.observe(document.body,{childList:true,subtree:true});});
    async function prepareRegion(bbox=config.bbox,manual=false) {
      if(busy)return;
      restoreDone=true;
      controller=new AbortController();setBusy(true);status('正在从原页准备无缩小的行裁图…','running');
      try {
        originalBlob = await config.getImage(); if(!live())return;
        const f=new FormData();f.append('file',originalBlob,'page.png');f.append('bbox',JSON.stringify(bbox));if(manual)f.append('manual','1');
        const value=await post(config.endpoint,'proofread-prepare',f,controller.signal);if(!live())return;
        if(value.version!==2 || !value.fragments?.length)throw new Error('裁图服务版本不符，请重启 AI OCR 服务');
        prepared=value;report=null;sourceSnapshot=fingerprint();selected.clear();selected.add(value.fragments[0].id);
        render();status(`已准备 ${value.rows} 行、${value.fragments.length} 个原图片段。${value.layout==='unresolved'?'分行不确定，可在更多选项中手动框选。':''}`);await persist();return value;
      }catch(error){if(live())status(`准备失败：${error.message}`,'error');}finally{setBusy(false);}
    }
    const prepareButton=button('准备原图 / 重新分行',()=>prepareRegion());
    const quickButton=button('快速疑点核查（所选片段）',()=>run('selected'));
    const fullButton=button('全行逐字复核',()=>run('full'));
    const retryButton=button('重试未完成片段',()=>run('retry'));
    const startButton=button('核对这一行',async()=>{
      if(busy)return;
      if(!prepared && !await prepareRegion())return;
      const hasCompleted=Object.values(report?.items||{}).some(item=>item.status==='done');
      const hasPending=prepared.fragments.some(piece=>report?.items?.[piece.id]?.status!=='done');
      await run(hasCompleted&&hasPending?'retry':'full');
    });startButton.className='visual-start-button';
    const stopButton=button('停止',stop);stopButton.disabled=true;
    const exportButton=button('导出校对证据',()=>{
      if(!prepared)return status('请先准备原图。');
      const value={version:2,context:config.contextKey,candidates:candidates(),prepared,report,exportedAt:new Date().toISOString()};
      const url=URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
      const a=element('a');a.href=url;a.download='藏文原图校对证据.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    });
    const primary=element('div',undefined,'visual-primary-controls');primary.append(startButton,stopButton);
    controls.append(prepareButton,quickButton,fullButton,retryButton,exportButton);
    const importBox=element('details');importBox.append(element('summary','加入聊天模式候选（粘贴当前行的完整文本）'));
    const labelInput=element('input');labelInput.placeholder='来源 / 模型名称';labelInput.setAttribute('aria-label','聊天候选来源');
    const textInput=element('textarea');textInput.className='tibetan-text';textInput.placeholder='仅粘贴本行对应的藏文。';textInput.setAttribute('aria-label','聊天候选文本');
    const importButton=button('加入候选',async()=>{
      if(!labelInput.value.trim()||!textInput.value.trim())return status('请填写来源和本行的藏文。','error');
      if(candidates().length>=16)return status('当前行最多支持 16 份候选。','error');
      restoreDone=true;
      imports.push({id:`import-${Date.now()}`,label:labelInput.value.trim(),text:textInput.value,source:'chat',importedAt:new Date().toISOString()});
      report=null;sourceSnapshot=fingerprint();textInput.value='';render();await persist();status('候选已加入；按当前原图重新核查。');
    });importBox.append(labelInput,textInput,importButton);
    advanced.append(controls,importBox,roster,selectionSlot,cacheStatus);
    header.append(primary);
    evidence.append(evidenceTitle,body,advanced);
    section.append(header,feedback,evidence);
    if(!config.bbox){startButton.disabled=prepareButton.disabled=quickButton.disabled=fullButton.disabled=true;status('没有可用的原图区域坐标。','error');}

    function render() {
      body.replaceChildren();
      roster.replaceChildren();selectionSlot.replaceChildren();
      for(const c of candidates()) {
        const row=element('details');row.append(element('summary',`${c.label} · ${c.source==='chat'?'聊天导入':'已有 OCR'}${c.model?` · ${c.model}`:''}`),element('div',c.text,'tibetan-text'));
        if(c.source==='chat')row.append(button('移除此候选',async()=>{if(busy)return;imports=imports.filter(v=>v.id!==c.id);report=null;sourceSnapshot=fingerprint();render();await persist();}));
        roster.append(row);
      }
      if(!prepared)return;
      const selectBox=element('details');selectBox.append(element('summary','检查原图范围 / 手动拖框选择一行或疑点'));
      const imgWrap=element('div',undefined,'visual-selection');const image=element('img');image.src=prepared.region_image;image.alt='当前原图区域，可拖框选择';image.draggable=false;
      const rectangle=element('div',undefined,'visual-selection-rect');rectangle.hidden=true;imgWrap.append(image,rectangle);
      let origin=null,selection=null;
      const point=e=>{const r=image.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-r.left)/r.width)),y:Math.max(0,Math.min(1,(e.clientY-r.top)/r.height))};};
      image.addEventListener('pointerdown',e=>{if(busy)return;e.preventDefault();origin=point(e);image.setPointerCapture(e.pointerId);});
      image.addEventListener('pointermove',e=>{if(!origin)return;const p=point(e);selection={x:Math.min(origin.x,p.x),y:Math.min(origin.y,p.y),width:Math.abs(origin.x-p.x),height:Math.abs(origin.y-p.y)};rectangle.hidden=false;Object.assign(rectangle.style,{left:selection.x*100+'%',top:selection.y*100+'%',width:selection.width*100+'%',height:selection.height*100+'%'});});
      image.addEventListener('pointerup',()=>{origin=null;});image.addEventListener('pointercancel',()=>{origin=null;});
      const crop=button('使用框选范围',()=>{if(!selection||selection.width<.01||selection.height<.01)return status('请先在图片中拖出一个有效区域。');const b=prepared.region_bbox;prepareRegion({x:b.x+selection.x*b.width,y:b.y+selection.y*b.height,width:selection.width*b.width,height:selection.height*b.height},true);});
      selectBox.append(element('p','保留上下加字及邻近上下文。手动范围按单行处理；核对前请确认没有混入邻行。'),imgWrap,crop);selectionSlot.append(selectBox);
      for(const piece of prepared.fragments) {
        const item=element('details',undefined,'visual-fragment');item.dataset.fragmentId=piece.id;
        const state=report?.items?.[piece.id];
        const title=element('summary',`原图 ${piece.row}-${piece.segment} · ${state?.status==='done'?'待查看':state?.status==='error'?'核对未完成':state?.status==='reading'?'核对中':'待核对'}`);
        item.append(title);
        const check=element('input');check.type='checkbox';check.checked=selected.has(piece.id);check.setAttribute('aria-label',`选择${piece.id}`);check.addEventListener('change',()=>check.checked?selected.add(piece.id):selected.delete(piece.id));
        const selectLabel=element('label','快速核查此片段 ');selectLabel.prepend(check);
        const cropImg=element('img');cropImg.src=piece.image;cropImg.alt=`第${piece.row}行第${piece.segment}片段原图`;cropImg.className='visual-evidence-image';
        cropImg.addEventListener('click',event=>{event.stopPropagation();config.onLocate(piece.page_bbox);});
        const imageHint=element('small','点击图片定位原页范围');
        item.append(cropImg,imageHint);
        const pieceTools=element('details');pieceTools.append(element('summary','片段选择与图像信息'),selectLabel,element('small',`原始裁片 ${piece.pixels.width}×${piece.pixels.height} 像素 · 自动定位为片段范围`));
        const context=element('details');context.append(element('summary','查看送审上下文及图像记录'));const ctxImage=element('img');ctxImage.src=piece.context_image;ctxImage.className='visual-evidence-image';ctxImage.alt='实际送审上下文裁图';context.append(ctxImage,element('small',`SHA-256：${piece.sha256}`));pieceTools.append(context);item.append(pieceTools);
        if(state?.error)item.append(element('p',state.error,'visual-error'));
        const readings=element('details');readings.append(element('summary','查看核图模型的读法'));
        for(const provider of ['gemini','qwen']) {
          const read=state?.reads?.[provider];
          if(read)readings.append(element('p',`${provider==='gemini'?'Gemini':'千问'} · ${read.legibility==='clear'?'模型称可辨认':'含不确定内容'}`),element('div',read.text,'tibetan-text'));
        }
        if(readings.children.length>1)item.append(readings);
        if(state?.comparisons)for(const compare of state.comparisons)renderComparison(item,compare,state,piece);
        if(piece===prepared.fragments[0] && (state?.status==='done'||state?.status==='error'||state?.status==='reading'))item.open=true;
        body.append(item);
      }
    }
    function coverage() {
      const items=Object.values(report?.items||{});const done=items.filter(i=>i.status==='done').length;
      const unresolved=items.flatMap(i=>i.comparisons||[]).filter(c=>c.state!=='supported' && c.state!=='match').length;
      startButton.textContent=report && !report.models?.provider?'重新核对':done && done<prepared.fragments.length?'继续核对':done===prepared.fragments.length?'重新核对':'核对这一行';
      evidenceTitle.textContent=`查看原图依据与设置${unresolved?`（${unresolved} 项待看）`:''}`;
      return `已核对 ${done}/${prepared.fragments.length} 处原图；${unresolved} 项差异待人工查看。${report?.mode==='selected'?'本次仅检查所选范围。':''}${report&&report.snapshot!==fingerprint()?'文字已改变，请重新核对。':''}`;
    }
    function renderComparison(container,c,item,piece) {
      const card=element('div',undefined,'visual-candidate-check');card.dataset.verdict=c.state;
      card.append(element('strong',c.label),element('p',c.state==='supported'?'疑似识别错误，请对照原图确认':c.state==='match'?'读图与候选一致，仍可人工核对':c.state==='unaligned'?'无法可靠定位，请对照原图':'读图有分歧，请对照原图'));
      const text=element('div',undefined,'tibetan-text');let cursor=c.start;
      if(c.reliable) {
        for(const edit of c.edits) {
          text.append(document.createTextNode(c.text.slice(cursor,edit.start)));
          const mark=element('mark',edit.original||'〔疑似缺字〕');mark.className=edit.state==='supported'?'visual-model-error':'visual-difference';mark.title=`${edit.type==='extra'?'疑似多字':edit.type==='missing'?'疑似漏字':'疑似替换'}：${edit.suggestion||'〔删除〕'}`;
          mark.addEventListener('click',event=>{event.stopPropagation();config.onLocate(piece.page_bbox);});text.append(mark);cursor=edit.end;
        }
        text.append(document.createTextNode(c.text.slice(cursor,c.end)));
      } else text.textContent=c.text;
      card.append(text);
      const evidence=element('details',undefined,'visual-reason-details');evidence.append(element('summary','查看读图建议与判断依据'));
      if(c.proposal)evidence.append(element('small','读图建议（可能错误）：'),element('div',c.proposal,'tibetan-text'));
      for(const p of ['gemini','qwen']) {const vs=item.verifications?.[p]?.verdicts?.filter(v=>(c.optionIds||[c.optionId]).includes(v.id))||[];for(const v of vs)evidence.append(element('p',`${p==='gemini'?'Gemini':'千问'}：${({supports_candidate:'支持原候选',supports_proposal:'支持建议',uncertain:'无法判断'})[v.verdict]}；${v.reason}`));}
      if(evidence.children.length>1)card.append(evidence);
      if(!c.reliable && c.source!=='chat' && config.onEdit)card.append(button('手动修改此识别',()=>config.onEdit(c.candidateId)));
      if(c.edits.length && c.reliable) {
        const decision=element('small',c.decision?`我的判断：${c.decision}`:'待人工确认');card.append(decision);
        for(const [label,value] of [['保留此识别','保留原文'],['稍后再看','暂不确定']])card.append(button(label,async()=>{c.decision=value;c.decidedAt=new Date().toISOString();decision.textContent=`我的判断：${value}`;await persist();}));
        if(c.source!=='chat' && config.onEdit)card.append(button('修改此识别',()=>config.onEdit(c.candidateId)));
        if(c.edits.every(edit=>edit.state==='supported')) {
        const accept=button('按建议修改',async()=>{
          try {
            await verifySource();
            if(!live()||report.snapshot!==fingerprint())throw new Error('文字或页面已改变，请重新核查');
            if(c.ambiguous||!c.reliable)throw new Error('对齐位置不可靠，请在原候选编辑区手动修改');
            const candidate=candidates().find(v=>v.id===c.candidateId);if(!candidate||candidate.text!==c.text)throw new Error('候选已改变');
            const changed=c.edits.reduceRight((text,e)=>algorithm().applyVisualEdit(text,e),candidate.text);
            if(candidate.source==='chat'){candidate.text=changed;}else await config.onApply(candidate,changed);
            c.decision='接受修改';c.decidedAt=new Date().toISOString();await persist();render();status('修改已保存；旧核图结果保留作证据，请重新核查更新后的文字。');
          }catch(error){status(error.message,'error');}
        });accept.disabled=c.ambiguous||!c.reliable||report.snapshot!==fingerprint();card.append(accept);
        }
      }
      container.append(card);
    }
    async function readPiece(piece,record,signal) {
      // One blind image reading per fragment. All saved OCR texts are compared locally.
      const {provider,model}=report.models;
      record.reads={};record.verifications={};
      const reading=await post(config.endpoint,'proofread-read',await imageForm(piece,provider,model),signal);
      if(reading.version!==2||reading.image_sha256!==piece.sha256)throw new Error('核图响应与当前裁图不一致');
      if(!current()||signal.aborted)throw new Error('页面或候选已改变，本次结果未采用');
      record.reads[provider]=reading;
      record.comparisons=candidates().map(candidate=>{
        const aligned=algorithm().alignVisualText(candidate.text,reading.text,{fragment:true,atStart:piece.first,atEnd:piece.last});
        return {...aligned,candidateId:candidate.id,label:candidate.label,source:candidate.source,text:candidate.text,proposal:reading.text,
          edits:aligned.edits.map(edit=>({...edit,state:'uncertain'})),
          state:!aligned.reliable?'unaligned':!aligned.edits.length&&reading.legibility==='clear'?'match':'uncertain'};
      });
    }
    async function run(mode) {
      if(busy)return;
      if(!prepared)return status('请先点击“准备原图 / 重新分行”。');
      if(!candidates().length)return status('请先识别或导入当前行的候选文本。','error');
      if(!config.isCurrent())return status('页面已改变，请重新打开校对。','error');
      setBusy(true);
      try {await verifySource();} catch(error){setBusy(false);status(error.message,'error');return;}
      if(!live()){setBusy(false);return;}
      const [provider,...name]=modelSelect.value.split(':');const models={provider,model:name.join(':')};sourceSnapshot=fingerprint();
      if(!report||report.snapshot!==sourceSnapshot||JSON.stringify(report.models)!==JSON.stringify(models))report={version:2,snapshot:sourceSnapshot,models,items:{},startedAt:new Date().toISOString()};
      const chosen=prepared.fragments.filter(p=>mode==='full'||mode==='selected'&&selected.has(p.id)||mode==='retry'&&report.items?.[p.id]?.status!=='done');
      if(!chosen.length){setBusy(false);return status('请选择需要核查的片段，或使用全行逐字复核。');}
      report.mode=mode;controller=new AbortController();setBusy(true);
      try {
        for(let i=0;i<chosen.length;i++) {
          if(controller.signal.aborted||!current())break;
          const piece=chosen[i];const record={status:'reading',reads:{},startedAt:new Date().toISOString()};report.items[piece.id]=record;
          status(`正在读原图 ${i+1}/${chosen.length}；完成后显示与已有 OCR 的差异。`,'running');render();
          try {await readPiece(piece,record,controller.signal);if(!current())throw new Error('页面或文字已改变');record.status='done';}
          catch(error){record.status='error';record.error=error.message;}
          record.finishedAt=new Date().toISOString();await persist();if(live())render();
        }
        if(live())status(controller.signal.aborted?'已停止。'+coverage():!current()?'候选文字已改变；请重新核对。':coverage(),Object.values(report.items).some(r=>r.status==='error')?'error':'complete');
      } finally {setBusy(false);}
    }
    section.invalidate=()=>{controller?.abort();render();status('候选已修改，旧结果仅供查阅；请重新核图。');};
    render();
    database(key).then(async saved=>{
      if(!live()||busy||restoreDone)return;restoreDone=true;
      if(saved?.version===2){
        setBusy(true);
        try {if(saved.prepared)await verifySource(saved.prepared);}
        catch(error){status(error.message,'error');return;}
        finally{setBusy(false);}
        imports=saved.imports||[];prepared=saved.prepared;report=saved.report;sourceSnapshot=saved.sourceSnapshot||'';
        if(prepared?.fragments?.length)selected.add(prepared.fragments[0].id);
        render();status(report?.snapshot===fingerprint()?coverage():'文字已改变，旧记录可在更多选项中查看；请重新核对。');}
    }).catch(()=>{cacheStatus.textContent='暂不能读取本机核图记录；本次仍可核查和导出。';});
    return section;
  }
  root.VisualProofreadPanel={create};
})(window);
