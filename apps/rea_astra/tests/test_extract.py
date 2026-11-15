import hashlib
import json
from pathlib import Path
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
from extract import read_asar


def archive(files, body=b"hello"):
    header = json.dumps({"files": files}).encode()
    padding = b"\0" * (-(len(header) + 4) % 4)
    pickle_size = 4 + len(header) + len(padding)
    return struct.pack("<4I", 4, pickle_size + 4, pickle_size, len(header)) + header + padding + body


class ArchiveTests(unittest.TestCase):
    def read(self, data):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.asar"
            path.write_bytes(data)
            return read_asar(path)

    def test_valid_integrity_and_unicode_member(self):
        digest = hashlib.sha256(b"hello").hexdigest()
        data, base, entries = self.read(archive({"α.js": {"offset": "0", "size": 5, "integrity": {"algorithm": "SHA256", "hash": digest}}}))
        self.assertEqual(data[base:], b"hello")
        self.assertEqual(entries[0]["sha256"], digest)
        self.assertTrue(entries[0]["integrity_verified"])

    def test_rejects_path_traversal_and_windows_separators(self):
        for name in ("..", "/tmp", "a/b", "a\\b", ""):
            with self.subTest(name=name), self.assertRaises(ValueError):
                self.read(archive({name: {"offset": "0", "size": 5}}))

    def test_rejects_bad_integrity_and_bounds(self):
        for member in ({"offset": "-1", "size": 1}, {"offset": "0", "size": 9}, {"offset": "0", "size": 5, "integrity": {"algorithm": "SHA256", "hash": "bad"}}):
            with self.subTest(member=member), self.assertRaises(ValueError):
                self.read(archive({"a": member}))

    def test_rejects_truncated_header(self):
        for data in (b"", struct.pack("<4I", 4, 4096, 4092, 4000)):
            with self.assertRaises(ValueError):
                self.read(data)

    def test_does_not_follow_link_or_unpacked_members(self):
        _, _, entries = self.read(archive({"link": {"link": "../../secret"}, "native.node": {"unpacked": True, "size": 100}}))
        self.assertEqual([e["kind"] for e in entries], ["link", "unpacked"])
        self.assertFalse(any(e["extracted"] for e in entries))


if __name__ == "__main__":
    unittest.main()
