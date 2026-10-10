"""Hostile offline fixtures for the read-only Cloud Build source metadata audit."""

import base64
import importlib.util
import json
import pathlib
import unittest
from contextlib import redirect_stdout
from io import StringIO
from subprocess import CompletedProcess
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).with_name("verify-cloud-build-source-crc32c.py")
SPEC = importlib.util.spec_from_file_location("crc32c_audit", SOURCE)
assert SPEC and SPEC.loader
AUDIT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(AUDIT)

PROJECT = "project-6b810532-a302-48dc-b56"
REGION = "us-west1"
ID = "ee2e3a1a-77d5-4ce5-9376-160fe34b7e9f"
BUCKET = f"{PROJECT}_cloudbuild"
NAME = "source/1791446145.643847-09575496af30414ab798ca925bf4d7f2.tgz"
GEN = "1791446146324000"
CRC = base64.b64encode(bytes.fromhex("a1b2c3d4")).decode()


def fixtures():
    b = {"id": ID, "projectId": PROJECT, "status": "SUCCESS", "source": {"storageSource": {"bucket": BUCKET, "object": NAME}},
         "sourceProvenance": {"resolvedStorageSource": {"bucket": BUCKET, "object": NAME, "generation": GEN}}}
    o = {"bucket": BUCKET, "name": NAME, "generation": GEN, "size": "3400000", "crc32c": CRC}
    return b, o


class TestCrc32cMetadata(unittest.TestCase):
    def test_valid_exact_source_is_metadata_only(self):
        b, m = fixtures()
        record = AUDIT.verify_metadata(b, m, PROJECT, REGION, ID)
        self.assertEqual(record["crc32c_base64"], CRC)
        self.assertIn("metadata-only", record["assessment"])

    def test_hostile_or_missing_evidence_fails_closed(self):
        corruptions = [
            ("bad build", lambda b, m: b.update(id="bad")),
            ("wrong status", lambda b, m: b.update(status="WORKING")),
            ("wrong project", lambda b, m: b.update(projectId="other-project")),
            ("missing resolved source", lambda b, m: b.pop("sourceProvenance")),
            ("repointed storage", lambda b, m: b["source"]["storageSource"].update(object="source/evil.tgz")),
            ("unexpected bucket", lambda b, m: b["sourceProvenance"]["resolvedStorageSource"].update(bucket="evil_bucket")),
            ("missing generation", lambda b, m: b["sourceProvenance"]["resolvedStorageSource"].pop("generation")),
            ("different generation", lambda b, m: m.update(generation="123")),
            ("different object", lambda b, m: m.update(name="source/other.tgz")),
            ("missing crc", lambda b, m: m.pop("crc32c")),
            ("bogus crc", lambda b, m: m.update(crc32c="bogus")),
            ("wrong length", lambda b, m: m.update(crc32c=base64.b64encode(b"abc").decode())),
            ("zero size", lambda b, m: m.update(size=0)),
            ("disallowed source path", lambda b, m: (
                b["sourceProvenance"]["resolvedStorageSource"].update(object="other/file.tgz"),
                b["source"]["storageSource"].update(object="other/file.tgz"),
                m.update(name="other/file.tgz"),
            )),
        ]
        for name, mutate in corruptions:
            with self.subTest(name=name):
                b, m = fixtures()
                mutate(b, m)
                with self.assertRaises(AUDIT.EvidenceError):
                    AUDIT.verify_metadata(b, m, PROJECT, REGION, ID)

    def test_cli_is_only_generation_pinned_read_only_queries(self):
        b, m = fixtures()
        queries = []

        def mocked_run(argv, **kwargs):
            queries.append(argv)
            response = b if len(queries) == 1 else m
            return CompletedProcess(argv, 0, json.dumps(response), "")

        stdout = StringIO()
        with patch.object(AUDIT.subprocess, "run", side_effect=mocked_run), \
             patch("sys.argv", ["audit", "--project", PROJECT, "--region", REGION, "--build-id", ID]), \
             redirect_stdout(stdout):
            self.assertEqual(AUDIT.main(), 0)
        self.assertEqual(queries, [
            ["gcloud", "builds", "describe", ID, f"--project={PROJECT}", f"--region={REGION}", "--format=json"],
            ["gcloud", "storage", "objects", "describe", f"gs://{BUCKET}/{NAME}#{GEN}", "--raw", "--format=json"],
        ])
        self.assertEqual(json.loads(stdout.getvalue())["source_generation"], GEN)


if __name__ == "__main__":
    unittest.main()
