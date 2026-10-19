import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function element(tag) {
  return {
    tag, children: [], dataset: {}, handlers: {}, className: '', textContent: '',
    append(...children) { this.children.push(...children); },
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, handler) { this.handlers[name] = handler; },
  };
}
function flatten(node) {
  return [node, ...(node.children || []).flatMap(flatten)];
}

const context = vm.createContext({
  console,
  window: {addEventListener() {}},
  document: {querySelector() { return null; }, createElement: element,
    createTextNode(value) { return {textContent: value}; }},
});
vm.runInContext(readFileSync(new URL('../app.js', import.meta.url), 'utf8'), context);
vm.runInContext('activateOcrSourceBlock = () => {}', context);

const results = element('div');
context.testResults = results;
vm.runInContext(`appendLineVisionEvidence(testResults, 'data:image/png;base64,AAAA', 'གུ་རུ་', 'གུ་རུ་', {}, 0)`, context);
const evidence = flatten(results);
assert.ok(evidence.some(node => node.tag === 'img' && node.src === 'data:image/png;base64,AAAA'),
  'the source crop corresponding to the vision request must appear with the text comparison');
assert.ok(evidence.some(node => node.textContent === 'Gemini 读图：'));
assert.ok(evidence.some(node => node.textContent === '千问读图：'));
assert.equal(evidence.filter(node => node.textContent === 'གུ་རུ་').length, 2);

const candidate = element('div');
context.testCandidate = candidate;
vm.runInContext(`appendLineVisionCandidate(testCandidate, {label:'Gemini Vision',text:'ཀྱེ་'},
  {marks:[],status:'unresolved',unresolved:true}, {}, 0)`, context);
assert.ok(flatten(candidate).some(node => String(node.textContent).includes('有差异') && String(node.textContent).includes('未能可靠定位')),
  'a Gemini Vision mismatch must have an explicit comparison result even without a red mark');
