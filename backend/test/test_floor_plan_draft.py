"""Exercise real OpenCV source extraction with a controlled image, independent of OCR binaries."""
import importlib.util, tempfile, unittest
from pathlib import Path
from PIL import Image, ImageDraw
spec=importlib.util.spec_from_file_location('draft',Path(__file__).resolve().parents[1]/'scripts/extract-floor-plan-draft.py')
draft=importlib.util.module_from_spec(spec);spec.loader.exec_module(draft)
class SourceLinework(unittest.TestCase):
    def test_pixel_coordinates_remain_explicitly_unscaled(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'plan.png'
            image=Image.new('RGB',(400,300),'white');draw=ImageDraw.Draw(image)
            draw.rectangle((30,30,370,270),outline='black',width=6)
            draw.line((200,30,200,240),fill='black',width=6);image.save(path)
            result=draft.image_page(path,'Tlocrt / Kupaonica')
            self.assertEqual((result['widthPx'],result['heightPx']),(400,300))
            self.assertGreater(len(result['segments']),4)
            self.assertTrue(all(0<=v<=1 for line in result['segments'] for v in line))
            self.assertEqual(result['text'],'Tlocrt / Kupaonica')
if __name__=='__main__':unittest.main()
