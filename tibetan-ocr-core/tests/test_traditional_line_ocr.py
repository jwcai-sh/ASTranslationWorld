"""Run with python3; no external model calls."""
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
from io import BytesIO
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import ai_vision_ocr_server as server
import bdrc_ocr_server as bdrc_server


class TraditionalLineTests(unittest.TestCase):
    def test_traditional_ocr_keeps_preview_rows_but_recognizes_original_page_once(self):
        output = BytesIO()
        Image.new('RGB', (1200, 400), 'white').save(output, format='PNG')
        image = output.getvalue()
        region = {'id': 'center', 'label': '中间', 'direction': 'horizontal',
                  'x': .1, 'y': .1, 'width': .8, 'height': .8}
        boxes = [{'x': .1, 'y': .1, 'width': .8, 'height': .1},
                 {'x': .1, 'y': .5, 'width': .8, 'height': .1}]
        def recognize(content, filename, rows, model):
            self.assertEqual(content, image)
            self.assertEqual([row['index'] for row in rows], [0, 1])
            return {'lines': [{'index': 0, 'text': 'གཅིག་'}, {'index': 1, 'text': 'གཉིས་'}],
                    'model': 'gemini:gemini-2.5-flash'}
        with patch.object(server, 'detect_physical_text_line_bboxes', return_value=boxes), \
             patch.object(server, 'call_gemini_page_review', side_effect=recognize) as request, \
             patch.object(server, 'call_line_review_vision') as cropped:
            result = server.call_traditional_region_ocr(image, 'sample.png', '', [region])
        request.assert_called_once()
        cropped.assert_not_called()
        self.assertEqual([line['text'] for line in result['lines']], ['གཅིག་', 'གཉིས་'])
        self.assertEqual(result['recognition_scope'], 'whole-page')
        self.assertEqual(result['failed_line_count'], 0)

    def test_tiling_cuts_at_whitespace_instead_of_through_a_glyph(self):
        from PIL import ImageDraw
        image = Image.new('RGB', (2200, 160), 'white')
        draw = ImageDraw.Draw(image)
        draw.rectangle((1470, 20, 1530, 140), fill='black')
        tiles, ranges = server.split_enlarged_line(image, 1500)
        self.assertLess(ranges[0][1], 1470)
        self.assertEqual(ranges[-1][1], image.width)
        self.assertGreater(ranges[0][1], ranges[1][0])
        self.assertLessEqual(ranges[0][1] - ranges[1][0], 48)
        self.assertEqual(len(tiles), 2)

    def test_legacy_crops_exclude_neighbours_and_preserve_detached_marks(self):
        from PIL import ImageDraw
        image = Image.new('RGB', (800, 300), 'white')
        draw = ImageDraw.Draw(image)
        # Three close rows with detached upper marks and lower stacks.
        for top, colour in [(70, 'black'), (120, 'black'), (170, 'red')]:
            for x in range(200, 550, 35):
                draw.rectangle((x, top + 8, x + 12, top + 24), fill=colour)
                draw.rectangle((x + 3, top, x + 9, top + 3), fill=colour)
                draw.rectangle((x + 4, top + 26, x + 8, top + 30), fill=colour)
        output = BytesIO(); image.save(output, format='PNG'); content = output.getvalue()
        center = {'id': 'center', 'x': .1, 'y': .1, 'width': .8, 'height': .8}
        local = [{'x': .15, 'y': (top - 30) / 240, 'width': .6, 'height': 31 / 240}
                 for top in (70, 120, 170)]
        with patch.object(server, 'detect_traditional_column_bboxes', return_value=[center]):
            for top in (70, 120, 170):
                # Old boxes have no clip metadata; generous padding would mix rows.
                bbox = {'x': .25, 'y': top / 300, 'width': .45, 'height': 31 / 300}
                _, metadata = server.prepare_line_review_images(content, bbox)
                pixels = metadata['crop_pixels']
                self.assertLessEqual(pixels['y'], top)
                self.assertGreaterEqual(pixels['y'] + pixels['height'], top + 31)
                self.assertGreater(pixels['y'], top - 20)
                self.assertLess(pixels['y'] + pixels['height'], top + 50)
                self.assertEqual(metadata['crop_version'], server.LINE_CROP_VERSION)

    def test_vertical_side_crop_is_not_treated_as_body_row(self):
        bbox = {'x': .8, 'y': .4, 'width': .01, 'height': .2}
        with patch.object(server, 'detect_traditional_column_bboxes') as detector:
            self.assertEqual(server.bound_legacy_line_crop(b'no image needed', bbox), bbox)
            detector.assert_not_called()

    def test_saved_middle_row_crop_excludes_frame_and_keeps_stack_marks(self):
        from PIL import ImageDraw
        image = Image.new('RGB', (1000, 300), 'white')
        draw = ImageDraw.Draw(image)
        draw.line((100, 35, 100, 260), fill='red', width=4)
        draw.line((900, 35, 900, 260), fill='red', width=4)
        for top in (78, 158):
            for x in range(220, 790, 40):
                draw.rectangle((x, top + 12, x + 12, top + 30), fill='black')
                draw.rectangle((x + 3, top, x + 8, top + 3), fill='black')
                draw.rectangle((x + 4, top + 33, x + 8, top + 37), fill='black')
        output = BytesIO(); image.save(output, format='PNG')
        center = {'id': 'center', 'x': .1, 'y': .1, 'width': .8, 'height': .8}
        with patch.object(server, 'detect_traditional_column_bboxes', return_value=[center]):
            _, metadata = server.prepare_line_review_images(output.getvalue(),
                {'x': .2, 'y': .25, 'width': .6, 'height': .14, 'physical_row_index': 0})
        pixels = metadata['crop_pixels']
        self.assertGreater(pixels['x'], 100)
        self.assertLess(pixels['x'] + pixels['width'], 900)
        self.assertLessEqual(pixels['y'], 78)
        self.assertGreaterEqual(pixels['y'] + pixels['height'], 115)
        self.assertLess(pixels['y'] + pixels['height'], 158)

    def test_broken_horizontal_frame_still_finds_middle_column(self):
        from PIL import ImageDraw
        image = Image.new('RGB', (1200, 260), 'white')
        draw = ImageDraw.Draw(image)
        for x in (120, 150, 1050, 1080):
            draw.line((x, 20, x, 235), fill=(190, 45, 45), width=3)
        for y in (65, 115, 165):
            for x in range(220, 1000, 35):
                draw.rectangle((x, y, x + 12, y + 14), fill='black')
        output = BytesIO(); image.save(output, format='PNG')
        regions = server.detect_traditional_column_bboxes(output.getvalue())
        self.assertEqual([region['id'] for region in regions], ['left', 'center', 'right'])
        self.assertGreater(regions[1]['x'], .12)
        self.assertLess(regions[1]['x'] + regions[1]['width'], .88)

    def test_vertical_side_region_uses_best_rotated_reading_not_first_single_glyph(self):
        image = bdrc_server.np.full((600, 1000, 3), 245, dtype=bdrc_server.np.uint8)
        # An asymmetric red mark lets the fake recognizer distinguish the two
        # rotations while keeping the actual page crop and rotation code real.
        bdrc_server.cv2.rectangle(image, (50, 36), (64, 48), (0, 0, 220), -1)
        ok, encoded = bdrc_server.cv2.imencode('.png', image)
        self.assertTrue(ok)
        regions = [
            {'id': 'left', 'label': '左侧', 'role': 'side', 'direction': 'vertical',
             'x': .04, 'y': .1, 'width': .1, 'height': .8},
            {'id': 'center', 'label': '中间', 'role': 'body', 'direction': 'horizontal',
             'x': .2, 'y': .1, 'width': .6, 'height': .8},
            {'id': 'right', 'label': '右侧', 'role': 'side', 'direction': 'vertical',
             'x': .86, 'y': .1, 'width': .1, 'height': .8},
        ]
        rotated_mark_sides = []

        def recognize(content, *_args):
            crop = bdrc_server.cv2.imdecode(bdrc_server.np.frombuffer(content, dtype=bdrc_server.np.uint8), bdrc_server.cv2.IMREAD_COLOR)
            _red_y, red_x = bdrc_server.np.where((crop[:, :, 2] > 150) & (crop[:, :, 2] > crop[:, :, 1] * 1.5))
            if crop.shape[1] < crop.shape[0]:
                return {'text': '།', 'lines': [{'text': '།'}], 'model': 'test'}
            if len(red_x):
                side = 'right' if float(red_x.mean()) > crop.shape[1] / 2 else 'left'
                rotated_mark_sides.append(side)
                text = 'ཀ' if side == 'right' else 'བོད་ཡིག'
                return {'text': text, 'lines': [{'text': text}], 'model': 'test'}
            return {'text': 'དབུས', 'lines': [{'text': 'དབུས'}], 'model': 'test'}

        with patch.object(bdrc_server, 'detect_traditional_column_bboxes', return_value=regions), \
             patch.object(bdrc_server, 'run_traditional_center_line_ocr', return_value=None), \
             patch.object(bdrc_server, 'run_ocr', side_effect=recognize):
            result = bdrc_server.run_traditional_region_ocr(encoded.tobytes(), 'traditional', 'Woodblock-Stacks', 'line', {})

        left = result['regions'][0]
        self.assertEqual(rotated_mark_sides, ['right', 'left'])
        self.assertEqual(left['text'], 'བོད་ཡིག')
        self.assertEqual(left['ocr_rotation'], 'counterclockwise')

    def test_center_line_recognition_never_receives_side_column_pixels(self):
        image = bdrc_server.np.full((600, 1000, 3), 245, dtype=bdrc_server.np.uint8)
        image[:, :180] = (0, 0, 220)
        image[:, 820:] = (220, 0, 0)
        detector_widths = []
        recognizer_crops = []

        def detect(content, include_masks=False):
            crop = bdrc_server.cv2.imdecode(bdrc_server.np.frombuffer(content, dtype=bdrc_server.np.uint8), bdrc_server.cv2.IMREAD_COLOR)
            detector_widths.append(crop.shape[1])
            return [
                {'x': .05, 'y': .1, 'width': .9, 'height': .2},
                {'x': .05, 'y': .6, 'width': .9, 'height': .2},
            ]

        def recognize(content, *_args):
            crop = bdrc_server.cv2.imdecode(bdrc_server.np.frombuffer(content, dtype=bdrc_server.np.uint8), bdrc_server.cv2.IMREAD_COLOR)
            recognizer_crops.append(crop)
            return {'text': 'དབུས', 'lines': [{'text': 'དབུས'}], 'model': 'test'}

        _, encoded = bdrc_server.cv2.imencode('.png', image)
        region = {'id': 'center', 'label': '中间', 'role': 'body', 'direction': 'horizontal',
                  'x': .2, 'y': .1, 'width': .6, 'height': .8}
        with patch.object(bdrc_server, 'detect_physical_text_line_bboxes', side_effect=detect), \
             patch.object(bdrc_server, 'run_ocr', side_effect=recognize):
            result = bdrc_server.run_traditional_center_line_ocr(image, region, 'line')

        self.assertEqual(result['line_count'], 2)
        self.assertEqual(detector_widths, [600])
        self.assertEqual(len(recognizer_crops), 2)
        for crop in recognizer_crops:
            self.assertFalse(bdrc_server.np.any((crop[:, :, 2] > 150) & (crop[:, :, 2] > crop[:, :, 1] * 1.5)))
            self.assertFalse(bdrc_server.np.any((crop[:, :, 0] > 150) & (crop[:, :, 0] > crop[:, :, 1] * 1.5)))

    def test_bad_frame_does_not_fall_back_to_whole_page(self):
        with patch.object(server, 'detect_traditional_column_bboxes', return_value=[]), \
             patch.object(server, 'call_model_aggregator') as model:
            with self.assertRaisesRegex(RuntimeError, '定位失败'):
                server.call_vision_model(b'irrelevant', 'sample.png', '', 'traditional')
            model.assert_not_called()


if __name__ == '__main__':
    unittest.main()
