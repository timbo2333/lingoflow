#!/usr/bin/env python3
"""Split ECDICT into validated CSV chunks and publish dictionary resources."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile
from typing import Any, BinaryIO, Iterable, Sequence


DEFAULT_TARGET_SIZE_BYTES = 8_000_000
DEFAULT_MAX_SIZE_BYTES = 10_000_000
GENERATED_CHUNK_RE = re.compile(r"^ecdict-\d{3,}\.csv$")


class DictionaryBuildError(RuntimeError):
    """Raised when the build or any integrity check fails."""


def set_csv_field_size_limit() -> None:
    """Use the largest CSV field limit supported by this Python build."""
    limit = sys.maxsize
    while True:
        try:
            csv.field_size_limit(limit)
            return
        except OverflowError:
            limit //= 10


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fingerprint(path: Path) -> tuple[int, str]:
    return path.stat().st_size, sha256_file(path)


class CsvRowEncoder:
    """Serialize rows exactly as Python's standard CSV writer would."""

    def __init__(self) -> None:
        self.buffer = io.StringIO(newline="")
        self.writer = csv.writer(self.buffer, dialect="excel", lineterminator="\r\n")

    def encode(self, row: Sequence[str]) -> bytes:
        self.buffer.seek(0)
        self.buffer.truncate(0)
        self.writer.writerow(row)
        return self.buffer.getvalue().encode("utf-8")


def split_ecdict(
    source_path: Path,
    stage_dir: Path,
    target_size_bytes: int,
    max_size_bytes: int,
) -> tuple[list[str], int, list[dict[str, Any]]]:
    encoder = CsvRowEncoder()
    chunks: list[dict[str, Any]] = []
    total_records = 0
    chunk_index = 0
    chunk_file: BinaryIO | None = None
    chunk_path: Path | None = None
    chunk_records = 0
    chunk_size = 0

    def start_chunk(header_bytes: bytes) -> None:
        nonlocal chunk_index, chunk_file, chunk_path, chunk_records, chunk_size
        chunk_index += 1
        chunk_path = stage_dir / f"ecdict-{chunk_index:03d}.csv"
        chunk_file = chunk_path.open("wb")
        chunk_file.write(header_bytes)
        chunk_records = 0
        chunk_size = len(header_bytes)

    def finish_chunk() -> None:
        nonlocal chunk_file
        if chunk_file is None or chunk_path is None:
            raise DictionaryBuildError("Internal error: no active ECDICT chunk")
        chunk_file.flush()
        chunk_file.close()
        chunk_file = None
        actual_size = chunk_path.stat().st_size
        if actual_size != chunk_size:
            raise DictionaryBuildError(
                f"Size accounting mismatch for {chunk_path.name}: "
                f"expected {chunk_size}, got {actual_size}"
            )
        if actual_size > max_size_bytes:
            raise DictionaryBuildError(
                f"{chunk_path.name} is {actual_size} bytes, above the "
                f"{max_size_bytes}-byte limit"
            )
        chunks.append(
            {
                "filename": chunk_path.name,
                "recordCount": chunk_records,
                "sizeBytes": actual_size,
            }
        )

    try:
        with source_path.open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source, dialect="excel", strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise DictionaryBuildError("ECDICT source is empty and has no header") from exc

            if not header:
                raise DictionaryBuildError("ECDICT header is empty")

            header_bytes = encoder.encode(header)
            if len(header_bytes) > max_size_bytes:
                raise DictionaryBuildError("ECDICT header alone exceeds the chunk size limit")
            start_chunk(header_bytes)

            for row in reader:
                row_bytes = encoder.encode(row)
                if len(header_bytes) + len(row_bytes) > max_size_bytes:
                    raise DictionaryBuildError(
                        f"CSV record {total_records + 1} cannot fit in one chunk "
                        f"under the {max_size_bytes}-byte limit"
                    )

                if chunk_records > 0 and chunk_size + len(row_bytes) > target_size_bytes:
                    finish_chunk()
                    start_chunk(header_bytes)

                if chunk_file is None:
                    raise DictionaryBuildError("Internal error: chunk file was not opened")
                chunk_file.write(row_bytes)
                chunk_records += 1
                chunk_size += len(row_bytes)
                total_records += 1

            finish_chunk()
    except csv.Error as exc:
        raise DictionaryBuildError(f"Invalid CSV near physical line {reader.line_num}: {exc}") from exc
    finally:
        if chunk_file is not None and not chunk_file.closed:
            chunk_file.close()

    return header, total_records, chunks


def read_csv_header_and_count(path: Path) -> tuple[list[str], int]:
    try:
        with path.open("r", encoding="utf-8-sig", newline="") as source:
            reader = csv.reader(source, dialect="excel", strict=True)
            try:
                header = next(reader)
            except StopIteration as exc:
                raise DictionaryBuildError(f"{path} has no CSV header") from exc
            return header, sum(1 for _ in reader)
    except csv.Error as exc:
        raise DictionaryBuildError(f"Cannot read {path} as CSV: {exc}") from exc


def validate_chunks(
    base_dir: Path,
    chunks: Iterable[dict[str, Any]],
    expected_header: list[str],
    max_size_bytes: int,
) -> int:
    total_records = 0
    for chunk in chunks:
        path = base_dir / chunk["filename"]
        if not path.is_file():
            raise DictionaryBuildError(f"Missing ECDICT chunk: {path}")

        actual_size = path.stat().st_size
        if actual_size != chunk["sizeBytes"]:
            raise DictionaryBuildError(
                f"Manifest size mismatch for {path.name}: "
                f"expected {chunk['sizeBytes']}, got {actual_size}"
            )
        if actual_size > max_size_bytes:
            raise DictionaryBuildError(
                f"{path.name} is {actual_size} bytes, above the size limit"
            )

        header, record_count = read_csv_header_and_count(path)
        if header != expected_header:
            raise DictionaryBuildError(f"Header mismatch in {path.name}")
        if record_count != chunk["recordCount"]:
            raise DictionaryBuildError(
                f"Record count mismatch for {path.name}: "
                f"expected {chunk['recordCount']}, got {record_count}"
            )
        total_records += record_count

    return total_records


def verify_lemma_copy(source_path: Path, copied_path: Path) -> None:
    if not copied_path.is_file():
        raise DictionaryBuildError(f"Missing lemma file: {copied_path}")
    if fingerprint(source_path) != fingerprint(copied_path):
        raise DictionaryBuildError("lemma.en.txt copy differs from the source")


def publish(stage_dir: Path, output_dir: Path, chunk_names: set[str]) -> None:
    existing_chunks = {
        path.name: path
        for path in output_dir.iterdir()
        if GENERATED_CHUNK_RE.fullmatch(path.name)
    }

    for chunk_name in sorted(chunk_names):
        os.replace(stage_dir / chunk_name, output_dir / chunk_name)

    os.replace(stage_dir / "lemma.en.txt", output_dir / "lemma.en.txt")

    for stale_name in sorted(existing_chunks.keys() - chunk_names):
        stale_path = existing_chunks[stale_name]
        if stale_path.is_dir() and not stale_path.is_symlink():
            raise DictionaryBuildError(
                f"Refusing to remove unexpected directory named {stale_path.name}"
            )
        stale_path.unlink()

    # Publish the manifest last so it only describes fully published resources.
    os.replace(stage_dir / "manifest.json", output_dir / "manifest.json")


def ensure_safe_paths(ecdict_source: Path, lemma_source: Path, output_dir: Path) -> None:
    for label, path in (("ECDICT", ecdict_source), ("lemma", lemma_source)):
        if not path.is_file():
            raise DictionaryBuildError(f"{label} source does not exist: {path}")

    output_dir_resolved = output_dir.resolve()
    lemma_destination = (output_dir_resolved / "lemma.en.txt").resolve()
    if lemma_destination == lemma_source.resolve():
        raise DictionaryBuildError("Lemma source and destination are the same file")

    if (
        ecdict_source.parent.resolve() == output_dir_resolved
        and GENERATED_CHUNK_RE.fullmatch(ecdict_source.name)
    ):
        raise DictionaryBuildError("ECDICT source path could be overwritten as a generated chunk")


def build_manifest(
    dictionary_version: str,
    total_records: int,
    chunks: list[dict[str, Any]],
    lemma_size: int,
) -> dict[str, Any]:
    return {
        "dictionaryVersion": dictionary_version,
        "ecdict": {
            "totalRecords": total_records,
            "chunkCount": len(chunks),
            "chunks": chunks,
        },
        "lemma": {
            "filename": "lemma.en.txt",
            "sizeBytes": lemma_size,
        },
    }


def parse_args() -> argparse.Namespace:
    project_root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--ecdict-source",
        type=Path,
        required=True,
        help="Path to the original ecdict.csv (opened read-only)",
    )
    parser.add_argument(
        "--lemma-source",
        type=Path,
        required=True,
        help="Path to the original lemma.en.txt (opened read-only)",
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=project_root / "data" / "dictionary",
        help="Dictionary output directory",
    )
    parser.add_argument(
        "--dictionary-version",
        default=dt.date.today().isoformat(),
        help="Value stored in manifest.json (default: today's date)",
    )
    parser.add_argument(
        "--target-size-bytes",
        type=int,
        default=DEFAULT_TARGET_SIZE_BYTES,
        help=f"Preferred chunk size (default: {DEFAULT_TARGET_SIZE_BYTES})",
    )
    parser.add_argument(
        "--max-size-bytes",
        type=int,
        default=DEFAULT_MAX_SIZE_BYTES,
        help=f"Hard chunk size limit (default: {DEFAULT_MAX_SIZE_BYTES})",
    )
    return parser.parse_args()


def run() -> dict[str, Any]:
    args = parse_args()
    ecdict_source = args.ecdict_source.expanduser().resolve()
    lemma_source = args.lemma_source.expanduser().resolve()
    output_dir = args.output_dir.expanduser().resolve()

    if args.target_size_bytes <= 0 or args.max_size_bytes <= 0:
        raise DictionaryBuildError("Chunk size limits must be positive")
    if args.target_size_bytes > args.max_size_bytes:
        raise DictionaryBuildError("Target chunk size cannot exceed the hard size limit")

    ensure_safe_paths(ecdict_source, lemma_source, output_dir)
    set_csv_field_size_limit()
    source_fingerprints_before = {
        "ecdict": fingerprint(ecdict_source),
        "lemma": fingerprint(lemma_source),
    }

    output_dir.mkdir(parents=True, exist_ok=True)
    stage_dir = Path(tempfile.mkdtemp(prefix=".dictionary-build-", dir=output_dir))

    try:
        header, split_record_count, chunks = split_ecdict(
            ecdict_source,
            stage_dir,
            args.target_size_bytes,
            args.max_size_bytes,
        )

        shutil.copyfile(lemma_source, stage_dir / "lemma.en.txt")
        verify_lemma_copy(lemma_source, stage_dir / "lemma.en.txt")

        original_header, original_record_count = read_csv_header_and_count(ecdict_source)
        if original_header != header:
            raise DictionaryBuildError("ECDICT header changed while the build was running")
        if original_record_count != split_record_count:
            raise DictionaryBuildError(
                "Original ECDICT record count differs from the number written to chunks"
            )

        staged_record_count = validate_chunks(
            stage_dir, chunks, header, args.max_size_bytes
        )
        if staged_record_count != original_record_count:
            raise DictionaryBuildError(
                "Original ECDICT record count differs from staged chunk total"
            )

        manifest = build_manifest(
            args.dictionary_version,
            original_record_count,
            chunks,
            (stage_dir / "lemma.en.txt").stat().st_size,
        )
        (stage_dir / "manifest.json").write_text(
            json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

        chunk_names = {chunk["filename"] for chunk in chunks}
        publish(stage_dir, output_dir, chunk_names)

        published_record_count = validate_chunks(
            output_dir, chunks, header, args.max_size_bytes
        )
        if published_record_count != original_record_count:
            raise DictionaryBuildError(
                "Original ECDICT record count differs from published chunk total"
            )
        verify_lemma_copy(lemma_source, output_dir / "lemma.en.txt")

        with (output_dir / "manifest.json").open("r", encoding="utf-8") as source:
            published_manifest = json.load(source)
        if published_manifest != manifest:
            raise DictionaryBuildError("Published manifest content is not the validated manifest")

        source_fingerprints_after = {
            "ecdict": fingerprint(ecdict_source),
            "lemma": fingerprint(lemma_source),
        }
        if source_fingerprints_after != source_fingerprints_before:
            raise DictionaryBuildError("An original dictionary source changed during the build")

        return {
            "sources": {
                "ecdict": str(ecdict_source),
                "lemma": str(lemma_source),
            },
            "outputDirectory": str(output_dir),
            "manifest": str(output_dir / "manifest.json"),
            "ecdict": {
                "originalRecords": original_record_count,
                "publishedRecords": published_record_count,
                "chunkCount": len(chunks),
                "chunks": chunks,
            },
            "lemma": manifest["lemma"],
            "checks": {
                "recordCountsMatch": True,
                "chunksReadableByCsvModule": True,
                "headersMatch": True,
                "lemmaCopyMatchesSource": True,
                "originalSourcesUnchanged": True,
                "manifestGenerated": True,
            },
        }
    finally:
        shutil.rmtree(stage_dir, ignore_errors=True)


def main() -> int:
    try:
        summary = run()
    except (DictionaryBuildError, OSError, UnicodeError, json.JSONDecodeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
