"""Integrity tests: failed downloads must not replace the previous snapshot."""

import importlib.util
import io
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

SPEC = importlib.util.spec_from_file_location("sync_parcelmap", Path(__file__).with_name("sync-parcelmap.py"))
sync = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(sync)


def archive_bytes():
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w") as archive:
        archive.writestr("parcels.gdb/a00000001.gdbtable", b"example data")
    return output.getvalue()


class Response(io.BytesIO):
    status = 200

    def __init__(self, payload, expected=None):
        super().__init__(payload)
        self.headers = {"Content-Length": str(len(payload) if expected is None else expected)}


class DownloadTests(unittest.TestCase):
    def test_complete_archive_is_preserved_exactly(self):
        payload = archive_bytes()
        with tempfile.TemporaryDirectory() as directory, patch.object(sync, "ROOT", Path(directory)):
            destination = Path(directory) / "source" / "parcels.zip"
            with patch.object(sync, "request", return_value=Response(payload)):
                result = sync.download("https://example.test/parcels.zip", destination)
            self.assertEqual(destination.read_bytes(), payload)
            self.assertEqual(result["sha256"], sync.hashlib.sha256(payload).hexdigest())
            self.assertTrue(result["zipCrcValidated"])

    def check_failure_keeps_snapshot(self, payload, expected=None, status=200):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "parcels.zip"
            destination.write_bytes(b"previous snapshot")

            def response(_url):
                result = Response(payload, expected)
                result.status = status
                return result

            with patch.object(sync, "request", side_effect=response), patch.object(sync.time, "sleep"):
                with self.assertRaises((ValueError, zipfile.BadZipFile)):
                    sync.download("https://example.test/parcels.zip", destination)
            self.assertEqual(destination.read_bytes(), b"previous snapshot")
            self.assertEqual(list(Path(directory).glob("*.part")), [])

    def test_truncated_download_keeps_previous_snapshot(self):
        self.check_failure_keeps_snapshot(archive_bytes(), expected=999999)

    def test_error_page_keeps_previous_snapshot(self):
        self.check_failure_keeps_snapshot(b"<html>Service unavailable</html>")

    def test_partial_response_keeps_previous_snapshot(self):
        self.check_failure_keeps_snapshot(archive_bytes(), status=206)

    def test_selects_warehouse_extract(self):
        catalogue = {"resources": [
            {"format": "fgdb", "url": "https://example.test/ParcelMapBCExtract.zip"},
            {"format": "fgdb", "url": "https://example.test/pmbc_parcel_poly_sv.zip"},
        ]}
        self.assertEqual(sync.archive_resource(catalogue), catalogue["resources"][1])


if __name__ == "__main__":
    unittest.main()
