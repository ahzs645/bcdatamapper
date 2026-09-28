import unittest
import numpy as np
from rasterio.transform import from_origin
from grid_class_reconstruction import reconstruct_grid


class GridTest(unittest.TestCase):
    def test_edge_noise_is_ignored_and_cells_do_not_shift(self):
        cells = np.array([[10,20,0],[30,40,10]], dtype='uint16')
        labels = np.repeat(np.repeat(cells,10,axis=0),10,axis=1)
        labels[:,:2] = 99
        labels[:,9:11] = 99
        result, grid, stats = reconstruct_grid(labels,from_origin(0,2,.1,.1),'EPSG:4326',west=0,north=2,step=1)
        np.testing.assert_array_equal(result,cells)
        self.assertEqual(grid,from_origin(0,2,1,1))
        self.assertEqual(stats['uncertainCells'],0)
        self.assertEqual(stats['nodataCells'],1)

    def test_conflict_and_sparse_evidence_remain_uncertain(self):
        labels = np.full((10,20),99,dtype='uint16')
        labels[:,:5]=10
        labels[:,5:10]=20
        labels[5,15]=10
        result,_,stats = reconstruct_grid(labels,from_origin(0,1,.1,.1),'EPSG:4326',west=0,north=1,step=1)
        np.testing.assert_array_equal(result,[[99,99]])
        self.assertEqual(stats['uncertainCells'],2)

    def test_partial_border_cells_are_not_extrapolated(self):
        labels = np.full((20,20),20,dtype='uint16')
        result,grid,_ = reconstruct_grid(labels,from_origin(.25,2.25,.1,.1),'EPSG:4326',west=0,north=3,step=1)
        self.assertEqual(result.shape,(1,1))
        self.assertEqual(grid,from_origin(1,2,1,1))


if __name__ == '__main__':
    unittest.main()
