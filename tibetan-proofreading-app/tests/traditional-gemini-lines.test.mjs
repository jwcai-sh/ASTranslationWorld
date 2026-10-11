import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const app = readFileSync(new URL('../app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('async function runTraditionalGeminiLines('), app.indexOf('function hasValidPageOcr('));
const helperStart = app.indexOf('function joinActiveOcrLines(');
const helperBrace = app.indexOf('{', helperStart);
let helperDepth = 0, helperEnd = -1;
for (let index = helperBrace; index < app.length; index += 1) {
  if (app[index] === '{') helperDepth += 1;
  if (app[index] === '}') helperDepth -= 1;
  if (helperDepth === 0) { helperEnd = index + 1; break; }
}
assert.notEqual(helperStart, -1, 'the production OCR line joiner must exist');
assert.notEqual(helperEnd, -1, 'the production OCR line joiner must have a complete body');
const joinActiveOcrLines = app.slice(helperStart, helperEnd);
const calls = [], saves = [], statuses = [];
const lines = [0, 1, 2].map(index => ({text:'〔尚未识别〕',missing:true,index,regionId:'center',bbox:{x:.1,y:.1+index*.2,width:.8,height:.1},reviewImage:{source_bbox:{clip_top:.1+index*.2}}}));
const state = {pageNum:1,cacheKey:'sample',ocrResults:new Map()};
const context = vm.createContext({state, Date,
  getOcrSourceCompare:()=>null,normalizeBbox:x=>x,setStatus:(text)=>statuses.push(text),
  callOcrEndpoint:async endpoint=>{assert.equal(endpoint,'http://localhost/line-layout');return {text:lines.map(x=>x.text).join('\n'),lines,raw:{line_ocr:true}};},
  getParsedOcrLines:p=>p.lines,getParsedOcrText:p=>p.text,
  saveOcrResultFromParsed:(p,source,status,fallback,view)=>{assert.equal(view,'proofread');state.ocrResults.set(1,{...p,source});},
  callAiVisionLineReviewEndpoint:async (endpoint,blob,bbox,draft,model,metadata,region)=>{
    calls.push({endpoint,bbox,draft,metadata,region});
    assert.equal(draft,'');assert.ok(metadata.source_bbox);assert.equal(region,'center');
    if(calls.length===1)throw new Error('test 503');
    return {text:'བོད།',raw:{model:'test',review_image:metadata}};
  },getOcrResponseModel:p=>p.model,formatNetworkError:e=>e.message,
  saveCachedResults:async options=>{assert.equal(options.immediateRemote,true);saves.push(state.ocrResults.get(1).text);},
  updateOcrPanelForPage:()=>{},updateSummary:()=>{},
});
vm.runInContext(`${joinActiveOcrLines}\n${source}`,context);
await context.runTraditionalGeminiLines('http://localhost/ocr',{});
assert.equal(calls.length,3);assert.equal(saves.length,3);
assert.equal(state.ocrResults.get(1).raw.failed_line_count,1);
assert.equal(state.ocrResults.get(1).lines[0].recognitionError,'test 503');
assert.equal(state.ocrResults.get(1).lines[2].text,'བོད།');
assert.ok(statuses.at(-1).includes('2 行成功，1 行失败'));
console.log('Traditional Gemini displays layout first, sends bounded crops without drafts, saves every row and continues after failure');
