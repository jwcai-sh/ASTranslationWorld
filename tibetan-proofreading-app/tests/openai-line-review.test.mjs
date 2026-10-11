import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const storage = new Map();
const elements = [];
const ctx = vm.createContext({console, window: {addEventListener() {}, localStorage: {
  getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value),
}}, document: {querySelector: () => null, createTextNode(text) {return {textContent:text};}, createElement() {
  const node = {children: [], isConnected: true, handlers: {}, append(...args) {this.children.push(...args);},
    setAttribute() {}, addEventListener(name, cb) {this.handlers[name] = cb;}};
  elements.push(node); return node;
}}});
vm.runInContext(readFileSync(new URL('../app.js', import.meta.url), 'utf8'), ctx);
vm.runInContext(`
  state.pageNum=1; state.pageCount=2; state.cacheKey='test'; state.sourceName='2②⅝⑦5⑦=3=51.pdf';
  state.ocrResults.set(1,{text:'original', lines:[{text:'original'}], source:'bdrc', compare:{
    bdrc:{text:'BDRC',lines:[{text:'BDRC'},{text:''},{text:'红字',bbox:{x:0,y:0,width:1,height:1}}]},llm:{text:'Gemini',lines:[{text:'Gemini'}]}}});
  getAiVisionLineReviewEndpoint=()=> 'http://localhost/line-review';
  getCurrentPageImageBlob=async()=>({});
  makeLineCropContext=()=>({cacheKey:state.cacheKey,pageNum:state.pageNum});
  getCachedLineCrop=async()=>({payload:{review_image:{crop_version:14}}});
  saveModelInputCrop=async()=>{};
  callAiVisionLineReviewEndpoint=async(endpoint,blob,bbox,draft)=> {
    if(!endpoint.endsWith('/openai-line-review') || draft!=='') throw Error('bad routing');
    return {text:'བོད་',raw:{model:'test-openai'}};
  };
  renderHomeDashboard=scheduleRemoteStateSave=updateOcrPanelForPage=()=>{};
  updateSummary=updateTranslationSummary=()=>{};
  renderOpenAiLineReview(0,{bbox:{x:.1,y:.2,width:.4,height:.1}},null,null);
`,ctx);
await elements.find(node => node.textContent === 'OpenAI 复核').handlers.click({stopPropagation(){}});
const saved = JSON.parse(storage.get('test')).ocrResults['1'];
assert.equal(saved.text,'original');
assert.equal(saved.compare.bdrc.text,'BDRC');
assert.equal(saved.compare.llm.text,'Gemini');
assert.equal(saved.compare.openaiReviews[0].text,'བོད་');
assert.equal(saved.compare.openaiReviews[0].model,'test-openai');
vm.runInContext('state.ocrResults.clear(); restoreCachedResults()',ctx);
assert.equal(vm.runInContext('state.ocrResults.get(1).compare.openaiReviews[0].text',ctx),'བོད་');
assert.equal(vm.runInContext('state.ocrResults.get(1).compare.openaiReviews.find(review => review.index === 2).text',ctx),'སྤྲུལ་སྐུ་ཉིད་ཀྱིས་མཛད།');
console.log('OpenAI candidate saves/restores without replacing BDRC or Gemini');
