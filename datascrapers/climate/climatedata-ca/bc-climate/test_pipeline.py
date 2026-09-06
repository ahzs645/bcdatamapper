"""Small synthetic fixtures only; no source datasets checked into Git."""
import tempfile
import json
import unittest
from unittest.mock import patch
from pathlib import Path

import h5py
import numpy as np
from shapely.geometry import box

from build import edges, make_grid, convert, selectors, load_boundary, provincial_outline, HERE
from acquire import open_url


class ClimateTests(unittest.TestCase):
    def test_provincial_outline_fills_internal_seams_without_moving_coast(self):
        outer=box(0,0,10,10)
        fragmented=outer.difference(box(4.999,1,5.001,9))
        self.assertTrue(provincial_outline(fragmented).equals(outer))

    def test_bc_boundary_includes_northern_rockies_and_stikine(self):
        recipe=json.loads((HERE/"recipe.json").read_text())
        boundary, hashes=load_boundary(recipe,HERE/"recipe.json")
        self.assertTrue(boundary.is_valid)
        self.assertEqual(len(hashes),2)
        # load_boundary itself rejects missing Fort Nelson, northeast BC,
        # Atlin, Stikine, islands, PG, Lower Mainland and Kootenay coverage.
        self.assertEqual(len(recipe["boundaryCoverageChecks"]),9)

    def test_r2_manifest_and_parts_use_identifiable_user_agent(self):
        with patch("urllib.request.urlopen") as request:
            open_url("https://example.test/sources.json")
            self.assertEqual(request.call_args.args[0].get_header("User-agent"), "BCDataMapper-Climate/1.0")

    def test_edges_and_reversed_axes(self):
        np.testing.assert_array_equal(edges([0.5,1.5,2.5]),[0,1,2,3])
        np.testing.assert_array_equal(edges([2.5,1.5,0.5]),[3,2,1,0])
        with self.assertRaises(ValueError): edges([1,1,2])

    def test_holes_and_shared_geometry(self):
        boundary=box(.1,.1,4.9,4.9).difference(box(.9,.9,4.1,4.1))
        grid=make_grid("test",np.arange(6),np.arange(6),boundary)
        tile=grid["tiles"][0]
        self.assertNotIn(12,tile["indices"])
        self.assertEqual(len(set(tile["indices"])),tile["count"])
        self.assertIn(0,tile["indices"])
        # Shared vertices come from the same coordinate, not separate rounding.
        self.assertEqual(grid["xEdges"][1],1)

    def test_kelvin_offset_only_for_absolute(self):
        band=dict(sourceUnits="K",measure="absolute")
        values=convert([273.15,np.nan],band,"°C")
        self.assertEqual(values[0],0)
        self.assertTrue(np.isnan(values[1]))
        self.assertEqual(convert([5],dict(sourceUnits="K",measure="source-delta"),"°C")[0],5)

    def test_season_is_decoded_from_cf_time_not_array_position(self):
        with tempfile.TemporaryDirectory() as tmp:
            with h5py.File(Path(tmp)/"fixture.nc","w") as f:
                f["horizon"]=[b"1971-2000"]*4
                f["time"]=[0,92,184,275]
                f["time"].attrs["units"]=b"days since 1971-03-01 00:00:00"
                f["time"].attrs["calendar"]=b"proleptic_gregorian"
                for suffix in ("", "_delta_1971_2000", "_delta_1991_2020"):
                    for percentile in ("p10","p50","p90"):
                        d=f.create_dataset("prcptot"+suffix+"_"+percentile,data=np.ones((4,2,2)))
                        d.attrs["units"]=b"mm day-1"
                bands=selectors(f,"prcptot")
                absolute=[b for b in bands if b["measure"]=="absolute" and b["percentile"]=="p50"]
                self.assertEqual([b["month"] for b in absolute],[3,6,9,12])
                self.assertEqual(len(bands),36)


if __name__=="__main__": unittest.main()
