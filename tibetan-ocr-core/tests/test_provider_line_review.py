import sys
from pathlib import Path
from unittest.mock import patch
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_vision_ocr_server as server


class ProviderReviewTests(unittest.TestCase):
    def test_transient_upstream_http_status_reaches_frontend(self):
        for code in (502, 503, 504):
            payload, status = server.ocr_error_response(RuntimeError(
                f'ModelAggregator image OCR failed: gemini: error (HTTP {code} high demand)'))
            self.assertEqual(status, code)
            self.assertTrue(payload['retryable'])
        for message in ('千问复核未配置', 'HTTP 401 invalid key', 'HTTP 429 quota',
                        'HTTP 503 unavailable; HTTP 403 permission denied',
                        'HTTP 503 high demand; 额度或频率限制', 'model mismatch'):
            payload, status = server.ocr_error_response(RuntimeError(message))
            self.assertEqual(status, 500)
            self.assertFalse(payload['retryable'])

    def test_line_review_http_route_preserves_503(self):
        from io import BytesIO
        from PIL import Image
        from threading import Thread
        from http.server import ThreadingHTTPServer
        import urllib.request
        import urllib.error
        import json
        out = BytesIO(); Image.new('RGB', (20, 20), 'white').save(out, format='PNG')
        boundary = 'test-row-boundary'
        content = ('--' + boundary + '\r\nContent-Disposition: form-data; name="bbox"\r\n\r\n'
                   '{"x":0.1,"y":0.1,"width":0.8,"height":0.8}\r\n--' + boundary +
                   '\r\nContent-Disposition: form-data; name="file"; filename="sample.png"\r\nContent-Type: image/png\r\n\r\n').encode()
        content += out.getvalue() + ('\r\n--' + boundary + '--\r\n').encode()
        http = ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        thread = Thread(target=http.serve_forever, daemon=True); thread.start()
        try:
            with patch.object(server, 'call_line_review_vision', side_effect=RuntimeError('HTTP 503 high demand')):
                req = urllib.request.Request(f'http://127.0.0.1:{http.server_port}/line-review', data=content,
                       headers={'Content-Type': 'multipart/form-data; boundary=' + boundary})
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    urllib.request.urlopen(req, timeout=3)
                self.assertEqual(caught.exception.code, 503)
                self.assertTrue(json.load(caught.exception)['retryable'])
        finally:
            http.shutdown(); http.server_close(); thread.join()

    def test_saved_crop_bounds_are_shared_and_rejected_on_another_page_size(self):
        from PIL import Image
        from io import BytesIO
        out = BytesIO(); Image.new('RGB', (100, 30), 'white').save(out, format='PNG')
        current = {'x': .1, 'y': .1, 'width': .8, 'height': .2}
        original = {'x': .2, 'y': .2, 'width': .6, 'height': .1, 'clip_top': .15, 'clip_bottom': .4}
        metadata = {'source_bbox': original, 'source_size': {'width': 100, 'height': 30}}
        self.assertEqual(server.resolve_saved_review_bbox(out.getvalue(), current, metadata), original)
        metadata['source_size']['height'] = 31
        self.assertEqual(server.resolve_saved_review_bbox(out.getvalue(), current, metadata), current)

    def test_qwen_preserves_selected_model_and_crop(self):
        from io import BytesIO
        from PIL import Image
        import base64
        page = Image.new('RGB', (800, 240), 'white')
        page.putpixel((400, 116), (175, 175, 175))
        output = BytesIO(); page.save(output, format='PNG')
        target = {'x': .1, 'y': .25, 'width': .8, 'height': .25}
        raw = {'model': 'qwen3.7-plus', 'choices': [{'finish_reason': 'stop', 'message': {'content': 'བོད་'}}]}
        with patch.object(server, 'QWEN_REVIEW_API_KEY', 'test-only'), patch.object(server, 'QWEN_REVIEW_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), patch.object(server, 'prepare_line_review_images', return_value=([b'png'], {'crop': 'tight', 'source_bbox': target})), patch.object(server, 'post_json', return_value=raw) as request:
            result = server.call_qwen_line_review(output.getvalue(), 'page.png', target, 'qwen3.7-plus')
            url, body, key = request.call_args.args
            self.assertTrue(url.endswith('/chat/completions'))
            self.assertEqual(body['model'], 'qwen3.7-plus')
            self.assertFalse(body['enable_thinking'])
            self.assertEqual(body['messages'][0]['content'][1]['max_pixels'], 8388608)
            content = body['messages'][0]['content']
            self.assertEqual(len(content), 4)  # prompt, page, raw wide band, row tile
            self.assertIn('重叠文字只转录一次', content[0]['text'])
            wide = Image.open(BytesIO(base64.b64decode(content[2]['image_url']['url'].split(',', 1)[1])))
            local_bbox = result['review_context']['local_bbox']
            self.assertLess(local_bbox['y'], round(target['y'] * page.height))
            self.assertGreater(local_bbox['y'] + local_bbox['height'], round((target['y'] + target['height']) * page.height))
            self.assertEqual(wide.getpixel((400 - local_bbox['x'], 116 - local_bbox['y'])), (175, 175, 175))
            self.assertEqual(result['provider'], 'qwen')
            self.assertEqual(result['review_image']['crop'], 'tight')
            self.assertEqual(result['text'], 'བོད་')

    def test_qwen_missing_key_bad_model_or_host_never_sends(self):
        with patch.object(server, 'post_json') as request:
            with self.assertRaisesRegex(RuntimeError, '允许列表'):
                server.call_qwen_line_review(b'', '', {}, 'unknown-model')
            with patch.object(server, 'QWEN_REVIEW_API_KEY', ''):
                with self.assertRaisesRegex(RuntimeError, '未配置'):
                    server.call_qwen_line_review(b'', '', {}, 'qwen3.8-max')
            with patch.object(server, 'QWEN_REVIEW_API_KEY', 'test-only'), patch.object(server, 'QWEN_REVIEW_BASE_URL', 'https://example.com/v1'):
                with self.assertRaisesRegex(RuntimeError, '官方 HTTPS'):
                    server.call_qwen_line_review(b'', '', {}, 'qwen3.8-max')
            request.assert_not_called()

    def test_truncated_qwen_is_rejected(self):
        with patch.object(server, 'QWEN_REVIEW_API_KEY', 'test-only'), patch.object(server, 'QWEN_REVIEW_BASE_URL', 'https://dashscope.aliyuncs.com/compatible-mode/v1'), patch.object(server, 'prepare_line_review_images', return_value=([b'png'], {})), patch.object(server, 'prepare_qwen_review_context', return_value=([b'page', b'local'], {})), patch.object(server, 'post_json', return_value={'choices': [{'finish_reason': 'length', 'message': {'content': 'བོད་'}}]}):
            with self.assertRaisesRegex(RuntimeError, '完整'):
                server.call_qwen_line_review(b'', '', {}, 'qwen3.8-max')

    def test_transcript_rejects_unrelated_json_and_preserves_tibetan(self):
        for value in ['```text\n{"vin码":"se72k210400000000000000"}\n```', 'No text found', '{"text":"བོད་"}']:
            with self.assertRaisesRegex(RuntimeError, '非藏文'):
                server.validate_qwen_transcript(value)
        self.assertEqual(server.validate_qwen_transcript('```text\nབོད་\n```'), 'བོད་')
        self.assertEqual(server.validate_qwen_transcript('689'), '689')

    def test_gemini_override_is_request_scoped_no_fallback(self):
        captured = []
        def upstream(url, body, key):
            if url.endswith('/upload'):
                return {'ok': True, 'id': 'test-image'}
            captured.append(body)
            return {'ok': True, 'modelRef': 'gemini:gemini-3.1-flash-lite', 'text': 'བོད་'}
        original_model = server.MODEL
        with patch.object(server, 'post_json', side_effect=upstream), patch.object(server, 'attach_layout_bboxes', return_value=([], [])):
            result = server.call_model_aggregator_images([(b'png', 'line.png')], 'read', preserve_size=True, model_override='gemini:gemini-3.1-flash-lite')
            self.assertEqual(captured[0]['models'], ['gemini:gemini-3.1-flash-lite'])
            self.assertFalse(captured[0]['allowFallback'])
            self.assertEqual(result['model'], 'gemini:gemini-3.1-flash-lite')
            self.assertEqual(server.MODEL, original_model)

    def test_gemini_selected_model_reaches_crop_request(self):
        with patch.object(server, 'USE_MODEL_AGGREGATOR', True), patch.object(server, 'prepare_line_review_images', return_value=([b'png'], {})), patch.object(server, 'call_model_aggregator_images', return_value={'text': 'བོད་'}) as request:
            server.call_line_review_vision(b'', '', {}, '', 'gemini-3.1-flash-lite')
            self.assertEqual(request.call_args.kwargs['model_override'], 'gemini:gemini-3.1-flash-lite')
            with self.assertRaisesRegex(RuntimeError, '允许列表'):
                server.call_line_review_vision(b'', '', {}, '', 'qwen3.5-ocr')


if __name__ == '__main__':
    unittest.main()
