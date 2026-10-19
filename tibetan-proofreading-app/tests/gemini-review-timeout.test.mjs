import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const storage = new Map();
const context = vm.createContext({
  console,
  Event,
  window: {addEventListener() {}, localStorage: {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
  }},
  document: {querySelector() { return null; }, createElement() {
    return {value: '', isConnected: true, children: [], handlers: {},
      setAttribute() {}, replaceChildren() { this.children = []; },
      appendChild(child) { this.children.push(child); },
      addEventListener(name, handler) { (this.handlers[name] ??= []).push(handler); },
      dispatchEvent(event) { for (const handler of this.handlers[event.type] || []) handler(event); }};
  }},
});
vm.runInContext(readFileSync(new URL('../app.js', import.meta.url), 'utf8'), context);

assert.equal(vm.runInContext('REVIEW_MODEL_DEFAULTS.gemini[0]', context), 'gemini-3.1-flash-lite');
vm.runInContext("state.cacheKey='old-project'; state.pageNum=1", context);
const preferenceKey = 'tibetan-proofreading-app:review-model:gemini:old-project:1:0';
storage.set(preferenceKey, 'gemini-3.8-flash');
const migrated = vm.runInContext("renderReviewModelSelector('gemini', 0)", context);
assert.equal(migrated.value, 'gemini-3.1-flash-lite');
assert.equal(storage.get(preferenceKey), 'gemini-3.1-flash-lite');
migrated.value = 'gemini-3.8-flash';
migrated.dispatchEvent(new Event('change'));
const selectedAgain = vm.runInContext("renderReviewModelSelector('gemini', 0)", context);
assert.equal(selectedAgain.value, 'gemini-3.8-flash');

const button = {disabled: false, dataset: {reviewModel: 'gemini-3.8-flash'}, isConnected: true};
const select = {value: 'gemini-3.8-flash', dispatched: false,
  dispatchEvent() { this.dispatched = true; }};
const feedback = {textContent: ''};
const card = {querySelector(selector) {
  return selector === '.proofread-ai-review-button' ? button
    : selector === '.review-model-select' ? select : feedback;
}};
context.testCard = card;
vm.runInContext(`
  els.aiOcrEndpointInput = {value: 'http://localhost/ocr'};
  getCurrentPageImageBlob = async () => 'page-image';
  runTraditionalGeminiLines = async () => { throw new Error('timed out'); };
  setStatus = () => {};
`, context);
await vm.runInContext('reviewOcrLineWithAiVision(0, testCard, null, null, null)', context);
assert.equal(select.value, 'gemini-3.1-flash-lite');
assert.equal(button.dataset.reviewModel, 'gemini-3.1-flash-lite');
assert.equal(select.dispatched, true);
assert.match(feedback.textContent, /已切换.*gemini-3\.1-flash-lite.*重试/);
assert.equal(button.disabled, false);
