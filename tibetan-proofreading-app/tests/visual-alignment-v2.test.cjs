const {test} = require('node:test');
const assert = require('node:assert/strict');
const {alignVisualText, applyVisualEdit} = require('../line-vision-proofread.js');
test('full alignment covers both edges and adjacent substitutions', () => {
  const a = alignVisualText('ཀཁགངཅཆ', 'ཚཁགངཇཉ');
  assert.deepEqual(a.edits.map(e => [e.original, e.suggestion]), [['ཀ','ཚ'],['ཅཆ','ཇཉ']]);
});
test('missing and surplus characters retain exact editable offsets', () => {
  for (const [a,b] of [['ཀཁག','ཀཅཁག'],['ཀཅཁག','ཀཁག'],['','ཀ'],['ཀ','']]) {
    const result = alignVisualText(a,b);
    assert.equal(result.edits.reduceRight((s,e) => applyVisualEdit(s,e), a), b);
  }
});
test('Tibetan stacks stay together and offsets preserve whitespace', () => {
  const a = alignVisualText(' ཀྱེ་ གུ་', 'ཀྱི་ གུ་');
  assert.equal(a.edits[0].original, 'ཀྱེ');
  assert.equal(a.edits[0].start, 1);
});
test('fragment maps without claiming omitted context as deletions', () => {
  const a = alignVisualText('ཀཁགངཅཆཇཉ', 'གངཚཆ', {fragment:true});
  assert.equal(a.start,2); assert.equal(a.end,6);
  assert.equal(a.edits.length,1); assert.equal(a.edits[0].suggestion,'ཚ');
});
test('repeated fragments are ambiguous', () => {
  assert.equal(alignVisualText('ཀཁགངཀཁགང','ཀཁགང',{fragment:true}).ambiguous,true);
});
test('stale edits cannot overwrite changed text', () => {
  assert.throws(() => applyVisualEdit('ཁ',{start:0,end:1,original:'ཀ',suggestion:'ག'}));
});
