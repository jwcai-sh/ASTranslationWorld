"""Whole-page BDRC output must survive display-only region annotation."""
import copy
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import bdrc_ocr_server as server


class WholePageTests(unittest.TestCase):
    def setUp(self):
        self.payload = {'text': '༄༅། བོད།\n༡', 'model': 'Woodblock-Stacks',
                        'lines': [
                            {'text': '༄༅། བོད།', 'bbox': {'x': .2, 'y': .3, 'width': .6, 'height': .1}},
                            {'text': '༡', 'bbox': {'x': .91, 'y': .3, 'width': .02, 'height': .1}}]}
        self.regions = [
            {'id': 'center', 'label': '中间', 'role': 'body', 'direction': 'horizontal',
             'x': .1, 'y': .1, 'width': .8, 'height': .8},
            {'id': 'right', 'label': '右侧', 'role': 'side', 'direction': 'vertical',
             'x': .9, 'y': .1, 'width': .1, 'height': .8}]

    def test_one_original_image_call_preserves_text_coordinates_and_order(self):
        original = copy.deepcopy(self.payload)
        with patch.object(server, 'run_ocr', return_value=self.payload) as recognize, \
             patch.object(server, 'detect_traditional_column_bboxes', return_value=self.regions), \
             patch.object(server, 'run_traditional_region_ocr') as cropped:
            result = server.run_page_ocr(b'original-page', 'traditional', '', '')
        recognize.assert_called_once_with(b'original-page', 'traditional', '', '')
        cropped.assert_not_called()
        self.assertEqual(result['text'], original['text'])
        self.assertEqual([(x['text'], x['bbox']) for x in result['lines']],
                         [(x['text'], x['bbox']) for x in original['lines']])
        self.assertEqual([x['region_id'] for x in result['lines']], ['center', 'right'])
        self.assertEqual(result['recognition_scope'], 'whole-page')
        self.assertNotIn('regions', result)  # frontend must read original lines
        self.assertEqual(self.payload, original)

    def test_http_endpoint_uses_whole_page_path(self):
        import json
        import threading
        import urllib.request
        http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.Handler)
        worker = threading.Thread(target=http.serve_forever, daemon=True)
        worker.start()
        body = (b'--boundary\r\nContent-Disposition: form-data; name="ocr_profile"\r\n\r\ntraditional\r\n'
                b'--boundary\r\nContent-Disposition: form-data; name="file"; filename="page.png"\r\n'
                b'Content-Type: image/png\r\n\r\noriginal-page\r\n--boundary--\r\n')
        try:
            with patch.object(server, 'run_ocr', return_value=self.payload) as recognize, \
                 patch.object(server, 'detect_traditional_column_bboxes', return_value=self.regions), \
                 patch.object(server, 'run_traditional_region_ocr') as cropped:
                request = urllib.request.Request(f'http://127.0.0.1:{http.server_port}/ocr', body,
                    {'Content-Type': 'multipart/form-data; boundary=boundary'})
                with urllib.request.urlopen(request, timeout=5) as response:
                    result = json.load(response)
                recognize.assert_called_once_with(b'original-page', 'traditional', '', '')
                cropped.assert_not_called()
                self.assertEqual(result['recognition_scope'], 'whole-page')
                self.assertEqual(result['text'], self.payload['text'])
        finally:
            http.shutdown()
            http.server_close()
            worker.join()

    def test_layout_failure_does_not_discard_successful_ocr(self):
        with patch.object(server, 'run_ocr', return_value=self.payload), \
             patch.object(server, 'detect_traditional_column_bboxes', side_effect=RuntimeError('bad frame')):
            result = server.run_page_ocr(b'original-page', 'traditional', '', '')
        self.assertEqual(result['text'], self.payload['text'])
        self.assertEqual(result['lines'], self.payload['lines'])

    def test_modern_profile_never_runs_traditional_layout(self):
        with patch.object(server, 'run_ocr', return_value=self.payload), \
             patch.object(server, 'detect_traditional_column_bboxes') as detect:
            result = server.run_page_ocr(b'original-page', 'modern', '', '')
        detect.assert_not_called()
        self.assertEqual(result['text'], self.payload['text'])


if __name__ == '__main__':
    unittest.main()
