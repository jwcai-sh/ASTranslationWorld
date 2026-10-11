import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const app = readFileSync(new URL("../app.js", import.meta.url), "utf8");
const server = readFileSync(new URL("../../tibetan-ocr-core/ai_vision_ocr_server.py", import.meta.url), "utf8");

assert.match(app, /function getAiVisionLineReviewEndpoint\(\)/, "the app needs a dedicated AI Vision line-review endpoint");
assert.match(app, /function reviewOcrLineWithAiVision\(index, card, sourceLine, bdrcLine, aiLine\)/, "each OCR row must be reviewable independently");
assert.match(app, /Gemini整页复核/, "the whole-page action must be visible to a proofreader");
assert.match(app, /getCurrentPageImageBlob\(\)/, "line review must use the same high-resolution OCR page image");
assert.match(app, /formData\.append\("bbox", JSON\.stringify\(bbox\)\)/, "line review must send the precise source bbox");
const sourceRowsStart = app.indexOf("function renderOcrSourceRows(");
const sourceRowsEnd = app.indexOf("function renderOcrSourceColumn(", sourceRowsStart);
assert.notEqual(sourceRowsStart, -1, "the line view must have source rows");
assert.match(
  app.slice(sourceRowsStart, sourceRowsEnd),
  /const showLineReview = !line\.deleted && \(side === "bdrc" \|\| isAiOnlyMode\(\)\)/,
  "eligible OCR source rows must expose independent review actions"
);
assert.match(
  app.slice(sourceRowsStart, sourceRowsEnd),
  /renderQwenLineReview\([\s\S]*renderOpenAiLineReview\([\s\S]*row\.append\(number, text, actions\)/,
  "the active row view must attach the available model review actions to each eligible row"
);
assert.match(server, /"\/line-review"/, "the AI OCR server must expose a dedicated line-review route");
assert.match(server, /def prepare_line_review_images\(/, "previews may still tightly crop the selected source line");
assert.match(server, /call_gemini_page_review/, "the review path must accept a complete page");

console.log("line review regression check passed");
