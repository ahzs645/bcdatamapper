import unittest
import numpy as np
from palette_classes import classify_rgba


class PaletteTest(unittest.TestCase):
    def test_palette_noise_ambiguity_and_alpha(self):
        palette = {10: [0, 100, 0], 20: [30, 144, 255], 30: [238, 201, 0], 40: [247, 247, 247]}
        pixels = [[0,100,0,255], [1,99,0,255], [30,144,255,255], [238,201,0,255],
                  [247,247,247,255], [15,122,128,255], [0,100,0,100], [247,247,247,0]]
        image = np.array(pixels, dtype='uint8').T[:, None, :]
        self.assertEqual(classify_rgba(image, palette).tolist(), [[10,10,20,30,40,99,99,0]])
        self.assertTrue(np.array_equal(classify_rgba(image, palette), classify_rgba(image, palette)))


if __name__ == '__main__':
    unittest.main()
