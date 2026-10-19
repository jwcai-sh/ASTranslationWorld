(function (root) {
  'use strict';

  const segmenter = new Intl.Segmenter('bo', { granularity: 'grapheme' });
  const uncertain = /[?？〔〕\[\]]/u;

  function tokens(value) {
    return [...segmenter.segment(String(value || ''))]
      .filter(({ segment }) => segment.trim())
      .map(({ segment, index }) => ({ value: segment.normalize('NFC'), start: index, end: index + segment.length }));
  }

  function uniqueReplacement(reading, left, right, original) {
    const units = tokens(reading);
    const found = [];
    for (let at = 4; at + 4 < units.length; at += 1) {
      if (!left.every((value, offset) => units[at - 4 + offset].value === value)) continue;
      if (!right.every((value, offset) => units[at + 1 + offset].value === value)) continue;
      const alternative = units[at].value;
      if (alternative !== original && !uncertain.test(alternative)) found.push(alternative);
    }
    return found.length === 1 ? found[0] : null;
  }

  function confirmVisionSubstitutions(candidate, geminiReading, qwenReading) {
    if (!candidate || !geminiReading || !qwenReading || uncertain.test(geminiReading) || uncertain.test(qwenReading)) return [];
    const units = tokens(candidate);
    const confirmed = [];
    for (let at = 4; at + 4 < units.length; at += 1) {
      const original = units[at].value;
      if (uncertain.test(original)) continue;
      const left = units.slice(at - 4, at).map(({ value }) => value);
      const right = units.slice(at + 1, at + 5).map(({ value }) => value);
      const sameContext = units.slice(4, -4).filter((_, position) => {
        const center = position + 4;
        return left.every((value, offset) => units[center - 4 + offset].value === value)
          && right.every((value, offset) => units[center + 1 + offset].value === value);
      });
      if (sameContext.length !== 1) continue;
      const gemini = uniqueReplacement(geminiReading, left, right, original);
      const qwen = uniqueReplacement(qwenReading, left, right, original);
      if (gemini && gemini === qwen) {
        confirmed.push({ start: units[at].start, end: units[at].end, original, suggestion: gemini });
      }
    }
    return confirmed;
  }

  function assessVisionCandidate(candidate, geminiReading, qwenReading) {
    const marks = confirmVisionSubstitutions(candidate, geminiReading, qwenReading);
    const normalized = (value) => tokens(value).map(({ value: unit }) => unit).join('');
    const candidateText = normalized(candidate);
    const geminiText = normalized(geminiReading);
    const qwenText = normalized(qwenReading);
    let afterMarks = String(candidate || '');
    for (const mark of [...marks].reverse()) {
      afterMarks = afterMarks.slice(0, mark.start) + mark.suggestion + afterMarks.slice(mark.end);
    }
    if (candidateText === geminiText && candidateText === qwenText) {
      return { marks, status: 'match', unresolved: false };
    }
    if (marks.length) {
      return { marks, status: 'confirmed', unresolved: normalized(afterMarks) !== geminiText || normalized(afterMarks) !== qwenText };
    }
    return { marks, status: geminiText === qwenText ? 'unresolved' : 'disagreement', unresolved: true };
  }


  // Semi-global alignment maps a crop transcript into a longer candidate.
  // Free ends are permitted only where the crop does not reach a block edge.
  // Costs prefer substitutions to a delete/insert pair; ties remain explicit.
  function alignVisualText(candidate, reading, options = {}) {
    candidate = String(candidate || ''); reading = String(reading || '');
    const a = tokens(candidate), b = tokens(reading), n = a.length, m = b.length;
    if ((n + 1) * (m + 1) > 3000000) throw new Error('文本过长，请按行或短片段核查');
    const freeStart = options.fragment && !options.atStart;
    const freeEnd = options.fragment && !options.atEnd;
    const width = m + 1, size = (n + 1) * width;
    const costs = new Int32Array(size), paths = new Uint8Array(size), ways = new Uint8Array(size);
    ways[0] = 1;
    for (let i = 1; i <= n; i++) { costs[i * width] = freeStart ? 0 : i * 2; paths[i * width] = 2; ways[i * width] = 1; }
    for (let j = 1; j <= m; j++) { costs[j] = j * 2; paths[j] = 3; ways[j] = 1; }
    for (let i = 1; i <= n; i++) for (let j = 1; j <= m; j++) {
      const at = i * width + j, diag = at - width - 1, up = at - width, left = at - 1;
      const d = costs[diag] + (a[i - 1].value === b[j - 1].value ? 0 : 3);
      const u = costs[up] + 2, l = costs[left] + 2, best = Math.min(d,u,l);
      costs[at] = best; paths[at] = best === d ? 1 : best === u ? 2 : 3;
      ways[at] = Math.min(2, (d === best ? ways[diag] : 0) + (u === best ? ways[up] : 0) + (l === best ? ways[left] : 0));
    }
    let finish = n, score = costs[n * width + m], count = ways[n * width + m];
    if (freeEnd) {
      score = Infinity; count = 0;
      for (let i = 0; i <= n; i++) {
        const at = i * width + m;
        if (costs[at] < score) { finish = i; score = costs[at]; count = ways[at]; }
        else if (costs[at] === score) count = Math.min(2, count + ways[at]);
      }
    }
    let i = finish, j = m; const ops = [];
    while (j > 0 || (!freeStart && i > 0)) {
      const step = paths[i * width + j];
      if (step === 1) { ops.push({kind:a[i-1].value === b[j-1].value ? 'equal' : 'replace', ai:i-1, bi:j-1}); i--; j--; }
      else if (step === 2) { ops.push({kind:'delete', ai:i-1, bi:j}); i--; }
      else if (step === 3) { ops.push({kind:'insert', ai:i, bi:j-1}); j--; }
      else break;
    }
    const begin = i; ops.reverse();
    const offset = k => k < n ? a[k].start : candidate.length;
    const edits = []; let group = null;
    const flush = () => {
      if (!group) return;
      const consumed = group.filter(o => o.kind !== 'insert');
      const produced = group.filter(o => o.kind !== 'delete');
      const start = offset(group[0].ai);
      const end = consumed.length ? a[consumed[consumed.length-1].ai].end : start;
      const suggestion = produced.length ? reading.slice(b[produced[0].bi].start,b[produced[produced.length-1].bi].end) : '';
      edits.push({start,end,original:candidate.slice(start,end),suggestion,
        type:start === end ? 'missing' : !suggestion ? 'extra' : 'replace',
        boundary:group[0] === ops[0] || group[group.length-1] === ops[ops.length-1]});
      group = null;
    };
    for (const op of ops) { if (op.kind === 'equal') flush(); else (group ||= []).push(op); } flush();
    const matches = ops.filter(o => o.kind === 'equal').length;
    return {start:offset(begin), end:finish ? a[finish-1].end : offset(begin), edits,
      ambiguous:count > 1, score, matches,
      reliable:count === 1 && !uncertain.test(reading) && (options.fragment ? matches >= Math.min(3,m) && score <= Math.max(4,m*1.5) : true)};
  }

  function applyVisualEdit(text, edit) {
    if (!Number.isInteger(edit.start) || !Number.isInteger(edit.end) || edit.start < 0 || edit.end < edit.start || edit.end > text.length
        || text.slice(edit.start,edit.end) !== edit.original) throw new Error('原文字已改变，请重新核对');
    return text.slice(0,edit.start) + edit.suggestion + text.slice(edit.end);
  }

  const api = { confirmVisionSubstitutions, assessVisionCandidate, alignVisualText, applyVisualEdit, tokens };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LineVisionProofread = api;
})(typeof window !== 'undefined' ? window : globalThis);
