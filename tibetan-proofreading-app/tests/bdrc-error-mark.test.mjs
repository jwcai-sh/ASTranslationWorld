import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

function setup(side) {
  const storage = new Map();
  const ctx = vm.createContext({console, window: {
    addEventListener() {},
    localStorage: {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)},
  }, document: {querySelector: () => null}});
  vm.runInContext(readFileSync(new URL('../app.js', import.meta.url), 'utf8'), ctx);
  vm.runInContext(`
    state.pageNum = 1; state.pageCount = 2; state.cacheKey = 'test-project';
    state.ocrResults.set(1, {source:'bdrc', text:'བོད་', lines:[{text:'བོད་'}], compare:{
      bdrc:{text:'བོད་', lines:[{text:'བོད་'}]},
      llm:{text:'different AI text', lines:[{text:'different AI text'}], model:'vision-model'},
    }});
    getSelectedProofreadRange = () => ({side:${JSON.stringify(side)}, index:0, start:0, end:2});
    renderCurrentOcrView = () => {};
    renderHomeDashboard = () => {};
    scheduleRemoteStateSave = () => {};
    updateSummary = updateTranslationSummary = () => {};
    setStatus = (message) => { window.lastStatus = message; };
  `, ctx);
  return {ctx, storage};
}

for (const side of ['bdrc', 'llm']) {
  test(`${side} selection marks only its own text and survives cache reload`, () => {
    const {ctx, storage} = setup(side);
    vm.runInContext('markSelectedSharedError(0, {})', ctx);
    const saved = JSON.parse(storage.get('test-project'));
    const mark = saved.ocrResults['1'].compare.sharedErrors[0];
    const key = side === 'bdrc' ? 'bdrcRanges' : 'llmRanges';
    const peer = side === 'bdrc' ? 'llmRanges' : 'bdrcRanges';
    assert.deepEqual(mark[key], [{start:0, end:2}]);
    assert.deepEqual(mark[peer], []);
    assert.equal(mark.text, (side === 'bdrc' ? 'བོད་' : 'different AI text').slice(0, 2));
    assert.match(ctx.window.lastStatus, side === 'bdrc' ? /BDRC/ : /Gemini Vision/);
    vm.runInContext('state.ocrResults.clear(); restoreCachedResults()', ctx);
    const restored = JSON.parse(vm.runInContext(`JSON.stringify(getSharedErrorRanges(state.ocrResults.get(1).compare, '${side}', 0, '${side === 'bdrc' ? 'བོད་' : 'different AI text'}'))`, ctx));
    assert.deepEqual(restored, [{start:0, end:2}]);
    vm.runInContext('getSelectedProofreadRange = () => null; clearSharedErrorMark(0, {})', ctx);
    assert.deepEqual(JSON.parse(storage.get('test-project')).ocrResults['1'].compare.sharedErrors, []);
  });
}

test('BDRC mark is included in saved OCR quality stats and clearing it updates the saved count', () => {
  const {ctx, storage} = setup('bdrc');
  vm.runInContext('state.ocrQualityReviews = []; markSelectedSharedError(0, {})', ctx);

  let payload = JSON.parse(storage.get('test-project'));
  assert.equal(payload.ocrQualityReviews.length, 1);
  assert.equal(payload.ocrQualityReviews[0].provider, 'bdrc');
  assert.equal(payload.ocrQualityReviews[0].reviewedChars, 3);
  assert.equal(payload.ocrQualityReviews[0].errorChars, 1);

  vm.runInContext('getSelectedProofreadRange = () => null; clearSharedErrorMark(0, {}, "bdrc")', ctx);
  payload = JSON.parse(storage.get('test-project'));
  assert.equal(payload.ocrQualityReviews.length, 1);
  assert.equal(payload.ocrQualityReviews[0].errorChars, 0);
});

test('saving the BDRC block choice persists its quality record', () => {
  const {ctx, storage} = setup('bdrc');
  vm.runInContext(`
    els.ocrText = {value:''};
    updateThumbnailState = () => {};
    saveProofreadBlockChoice(0, 'bdrc', null);
  `, ctx);

  const payload = JSON.parse(storage.get('test-project'));
  assert.equal(payload.ocrResults['1'].text, 'བོད་');
  assert.equal(payload.ocrQualityReviews.length, 1);
  assert.equal(payload.ocrQualityReviews[0].provider, 'bdrc');
  assert.equal(payload.ocrQualityReviews[0].reviewedChars, 3);
});
