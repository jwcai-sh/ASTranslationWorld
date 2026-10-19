import sys, unittest
from pathlib import Path
from io import BytesIO
import base64
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from PIL import Image
from visual_proofread import prepare, png, validate_read, validate_verdict, pixel_box

class VisualEvidenceTest(unittest.TestCase):
    def test_tiles_preserve_pixels_and_cover_edges(self):
        image=Image.new('RGB',(3200,160),'white'); image.putpixel((0,10),(23,45,67)); image.putpixel((3199,10),(98,76,54))
        result=prepare(png(image),dict(x=0,y=0,width=1,height=1),lambda _:[],True)
        tiles=result['fragments']; self.assertTrue(tiles[0]['row_first']); self.assertTrue(tiles[-1]['row_last']); self.assertFalse(tiles[0]['first'])
        end=0
        for tile in tiles:
            p=tile['pixels']; self.assertLessEqual(p['x'],end); end=p['x']+p['width']
            actual=Image.open(BytesIO(base64.b64decode(tile['image'].split(',')[1])))
            expected=image.crop((p['x'],p['y'],end,p['y']+p['height']))
            self.assertEqual(actual.tobytes(),expected.tobytes())
        self.assertEqual(end,3200)
    def test_invalid_boxes(self):
        for x in (-.1,float('nan'),2):
            with self.assertRaises(ValueError): pixel_box(dict(x=x,y=0,width=.5,height=1),(100,100))
    def test_uncertain_read_is_not_clear(self):
        self.assertEqual(validate_read('{"text":"ཀ〔?〕","legibility":"clear"}')['legibility'],'partial')
    def test_missing_duplicate_or_unknown_verdict_rejected(self):
        options=[{'id':'c0'},{'id':'c1'}]
        for raw in ['{"verdicts":[]}','{"verdicts":[{"id":"c0","verdict":"supports_proposal","reason":"x"},{"id":"c0","verdict":"supports_proposal","reason":"x"}]}']:
            with self.assertRaises(ValueError): validate_verdict(raw,options)

class ReviewRegressionTest(unittest.TestCase):
    def test_multirow_region_retains_all_overlapping_rows(self):
        from visual_proofread import expand_region
        region, rows=expand_region(dict(x=.1,y=.1,width=.8,height=.6),[
            dict(x=.2,y=.15,width=.6,height=.1),dict(x=.2,y=.35,width=.6,height=.1),dict(x=.2,y=.55,width=.6,height=.1),dict(x=.2,y=.8,width=.6,height=.1)])
        self.assertEqual(len(rows),3)
        self.assertLessEqual(region['y'],.15)
        self.assertGreaterEqual(region['y']+region['height'],.65)
    def test_gemini_review_uses_multimodal_chat_without_markdown_system(self):
        import ai_vision_ocr_server as server
        from unittest.mock import patch
        with patch.object(server,'USE_MODEL_AGGREGATOR',True), patch.object(server,'GEMINI_REVIEW_MODELS',['example']), patch.object(server,'post_json',return_value={'ok':True,'modelRef':'gemini:example','answer':'{}','finishReason':'STOP'}) as call:
            text,model=server.request_visual_proofread('gemini','example',[(b'pixels','detail.png')],'JSON please')
            args=call.call_args.args
            self.assertTrue(args[0].endswith('/chat'))
            self.assertEqual(args[1]['messages'][1]['content'][1]['type'],'image_url')
            self.assertEqual((text,model),('{}','gemini:example'))

    def test_qwen_truncated_output_is_not_adopted(self):
        import ai_vision_ocr_server as server
        from unittest.mock import patch
        with patch.object(server,'QWEN_REVIEW_MODELS',['example']), patch.object(server,'QWEN_REVIEW_API_KEY','test-only'), patch.object(server,'QWEN_REVIEW_BASE_URL','https://dashscope.aliyuncs.com/compatible-mode/v1'), patch.object(server,'post_json',return_value={'choices':[{'message':{'content':'partial'},'finish_reason':'length'}]}):
            with self.assertRaisesRegex(RuntimeError,'达到输出长度上限'):
                server.request_visual_proofread('qwen','example',[(b'pixels','detail.png')],'JSON please')

if __name__=='__main__': unittest.main()
