const assert = require('node:assert/strict');
const { confirmVisionSubstitutions, assessVisionCandidate } = require('../line-vision-proofread.js');

const base = 'ཀཁགངཅཆཇཉཏཐདན';
const changed = 'ཀཁགངཅཚཇཉཏཐདན';
assert.deepEqual(confirmVisionSubstitutions(base, changed, changed).map(({original, suggestion}) => ({original, suggestion})),
  [{original: 'ཆ', suggestion: 'ཚ'}]);
assert.deepEqual(confirmVisionSubstitutions(base, changed, base), [], 'one model disagreement cannot create a red mark');
assert.deepEqual(confirmVisionSubstitutions(base, changed, 'ཀཁགངཅཙཇཉཏཐདན'), [], 'different alternatives cannot create a red mark');
assert.deepEqual(confirmVisionSubstitutions(base, 'ཀཁགངཅཚཇཉཏཐདནཀཁགངཅཚཇཉཏཐདན', changed), [], 'ambiguous context cannot create a red mark');
assert.deepEqual(confirmVisionSubstitutions(base, changed, '〔?〕'), [], 'uncertain transcript cannot create a red mark');
assert.deepEqual(confirmVisionSubstitutions(base + base, changed, changed), [], 'repeated candidate context cannot create a red mark');
assert.deepEqual(confirmVisionSubstitutions('ཀཁགངཅ', 'ཀཁགངཚ', 'ཀཁགངཚ'), [], 'edge without both anchors cannot create a red mark');
console.log('line vision proofreading conservatively confirms only two-model, uniquely aligned substitutions');

const geminiCandidate = 'ཀཁགངཅཆཇཉཏཐདན';
assert.deepEqual(assessVisionCandidate(geminiCandidate, changed, changed), {
  marks: [{ start: 5, end: 6, original: 'ཆ', suggestion: 'ཚ' }],
  status: 'confirmed',
  unresolved: false,
}, 'Gemini Vision candidate must be checked by the same image-based rule as other OCR candidates');
assert.equal(assessVisionCandidate(changed, changed, changed).status, 'match');
assert.equal(assessVisionCandidate('ཀཁགངཅཆཇཉཏཐདན', changed, base).status, 'disagreement');
assert.equal(assessVisionCandidate('ཀཁགངཅཆཇཉཏཐདན', 'གུ་རུ', 'གུ་རུ').status, 'unresolved',
  'a longer mismatch must be shown as an unresolved image comparison rather than silently omitted');
