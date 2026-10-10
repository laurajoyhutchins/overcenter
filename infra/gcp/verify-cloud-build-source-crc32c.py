#!/usr/bin/env python3
"""Read-only, generation-pinned Cloud Build source CRC32C metadata audit.

This audits stored metadata. It does not prove that the upload supplied an
end-to-end checksum or independently recompute a digest over local source.
"""

import argparse
import base64
import json
import re
import subprocess
import sys
from collections.abc import Mapping
from typing import Any

BUILD_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\Z")
PROJECT_ID = re.compile(r"[a-z][a-z0-9-]{4,62}\Z")
REGION = re.compile(r"[a-z]+(?:-[a-z]+)*[0-9]+\Z")
STAGING_OBJECT = re.compile(r"source/[0-9A-Za-z._-]+\.tgz\Z")
POSITIVE_INT = re.compile(r"[1-9][0-9]*\Z")


class EvidenceError(ValueError):
    """Missing or contradictory authoritative provider evidence."""


def obj(value: Any, name: str) -> Mapping[str, Any]:
    if not isinstance(value, dict):
        raise EvidenceError(f"{name} must be an object")
    return value


def positive_number(value: Any, name: str) -> str:
    text = str(value) if isinstance(value, (str, int)) and not isinstance(value, bool) else ""
    if not POSITIVE_INT.fullmatch(text):
        raise EvidenceError(f"{name} must be a positive integer")
    return text


def verify_metadata(
    build: Mapping[str, Any], metadata: Mapping[str, Any], project: str, region: str, build_id: str
) -> dict[str, Any]:
    """Fail closed on identity, resolved generation, or checksum discrepancies."""
    if str(build.get("id")) != build_id or build.get("status") != "SUCCESS":
        raise EvidenceError("build identity or successful status is not established")
    if build.get("projectId") != project:
        raise EvidenceError("build project does not match the requested project")
    resolved = obj(obj(build.get("sourceProvenance"), "sourceProvenance").get("resolvedStorageSource"), "resolvedStorageSource")
    declared = obj(obj(build.get("source"), "source").get("storageSource"), "storageSource")
    bucket, name = resolved.get("bucket"), resolved.get("object")
    if bucket != f"{project}_cloudbuild" or not isinstance(name, str) or not STAGING_OBJECT.fullmatch(name):
        raise EvidenceError("source is not a recognized project Cloud Build staging archive")
    if declared.get("bucket") != bucket or declared.get("object") != name:
        raise EvidenceError("resolved source does not match the build's declared source")
    generation = positive_number(resolved.get("generation"), "resolved generation")
    if declared.get("generation") not in (None, "", "0", 0, generation, int(generation)):
        raise EvidenceError("declared source generation contradicts resolved generation")
    if metadata.get("bucket") != bucket or metadata.get("name") != name:
        raise EvidenceError("object metadata identity mismatch")
    if positive_number(metadata.get("generation"), "observed generation") != generation:
        raise EvidenceError("object metadata generation mismatch")
    size = positive_number(metadata.get("size"), "object size")
    crc32c = metadata.get("crc32c")
    if not isinstance(crc32c, str):
        raise EvidenceError("object has no CRC32C metadata")
    try:
        raw_crc = base64.b64decode(crc32c, validate=True)
    except ValueError as exc:
        raise EvidenceError("CRC32C metadata is not valid base64") from exc
    if len(raw_crc) != 4 or base64.b64encode(raw_crc).decode("ascii") != crc32c:
        raise EvidenceError("CRC32C metadata must encode exactly four bytes canonically")
    return {
        "schema": "overcenter-cloud-build-staging-crc32c-metadata/v1",
        "assessment": "metadata-only-not-independent-content-verification",
        "build_id": build_id,
        "project": project,
        "region": region,
        "source_bucket": bucket,
        "source_object": name,
        "source_generation": generation,
        "object_size_bytes": size,
        "crc32c_base64": crc32c,
    }


def gcloud_json(*args: str) -> Mapping[str, Any]:
    result = subprocess.run(["gcloud", *args], check=True, capture_output=True, text=True)
    return obj(json.loads(result.stdout), "gcloud JSON response")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--project", required=True)
    parser.add_argument("--region", required=True)
    parser.add_argument("--build-id", required=True)
    args = parser.parse_args()
    if not PROJECT_ID.fullmatch(args.project) or not REGION.fullmatch(args.region) or not BUILD_ID.fullmatch(args.build_id):
        parser.error("project, region, or build id has an invalid format")
    try:
        build = gcloud_json("builds", "describe", args.build_id, f"--project={args.project}", f"--region={args.region}", "--format=json")
        source = obj(obj(build.get("sourceProvenance"), "sourceProvenance").get("resolvedStorageSource"), "resolvedStorageSource")
        bucket, name = source.get("bucket"), source.get("object")
        gen = positive_number(source.get("generation"), "resolved generation")
        if bucket != f"{args.project}_cloudbuild" or not isinstance(name, str) or not STAGING_OBJECT.fullmatch(name):
            raise EvidenceError("unexpected Cloud Build source coordinate")
        metadata = gcloud_json("storage", "objects", "describe", f"gs://{bucket}/{name}#{gen}", "--raw", "--format=json")
        print(json.dumps(verify_metadata(build, metadata, args.project, args.region, args.build_id), sort_keys=True, indent=2))
        return 0
    except (EvidenceError, json.JSONDecodeError, subprocess.CalledProcessError) as exc:
        print(f"Cloud Build CRC32C metadata audit failed: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
