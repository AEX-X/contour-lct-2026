from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import time

import duckdb
import py7zr


COLUMNS = [
    "ид_события",
    "ид_канала_данных",
    "дата",
    "время",
    "тревожное",
    "значение_датчика",
]
YEARS = tuple(range(2019, 2027))
DEDUPLICATED_YEARS = {2019, 2023}
MIN_FREE_BYTES = 8 * 1024**3
PARQUET_MAGIC = b"PAR1"


def sql_literal(value: Path | str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def is_parquet(path: Path) -> bool:
    if not path.is_file() or path.stat().st_size < 12:
        return False
    with path.open("rb") as stream:
        start = stream.read(4)
        stream.seek(-4, os.SEEK_END)
        finish = stream.read(4)
    return start == PARQUET_MAGIC and finish == PARQUET_MAGIC


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_expected_archives(repo: Path) -> dict[str, dict[str, object]]:
    manifest_path = repo / "ml" / "docs" / "sources.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    expected = {
        item["name"]: item
        for item in manifest["dataset"]["files"]
        if item["name"].startswith("ext-journal-") and item["name"].endswith(".7z")
    }
    wanted_names = {f"ext-journal-{year}.7z" for year in YEARS}
    if set(expected) != wanted_names:
        raise RuntimeError(f"Unexpected archive manifest in {manifest_path}")
    return expected


def verify_archives(source: Path, expected: dict[str, dict[str, object]]) -> list[Path]:
    actual = {path.name: path for path in source.glob("ext-journal-*.7z")}
    if set(actual) != set(expected):
        missing = sorted(set(expected) - set(actual))
        extra = sorted(set(actual) - set(expected))
        raise RuntimeError(f"Archive set mismatch. Missing={missing}; extra={extra}")

    verified: list[Path] = []
    for name in sorted(expected):
        path = actual[name]
        metadata = expected[name]
        actual_bytes = path.stat().st_size
        if actual_bytes != metadata["bytes"]:
            raise RuntimeError(
                f"Size mismatch for {name}: expected {metadata['bytes']}, got {actual_bytes}"
            )
        actual_hash = sha256(path)
        if actual_hash != metadata["sha256"]:
            raise RuntimeError(
                f"SHA-256 mismatch for {name}: expected {metadata['sha256']}, got {actual_hash}"
            )
        print(
            json.dumps(
                {"archive": name, "status": "verified", "bytes": actual_bytes, "sha256": actual_hash}
            ),
            flush=True,
        )
        verified.append(path)
    return verified


def load_official_prepare(repo: Path):
    module_path = repo / "ml" / "outputs" / "ml-dataset" / "prepare.py"
    spec = importlib.util.spec_from_file_location("contour_ml_prepare", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot load official prepare function from {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.prepare


def extract_csv(archive: Path, target_dir: Path) -> Path:
    expected_name = f"{archive.stem}.csv"
    expected = target_dir / expected_name
    if expected.is_file():
        return expected

    if target_dir.exists():
        shutil.rmtree(target_dir)
    target_dir.mkdir(parents=True)
    password = os.getenv("CONTOUR_DATASET_PASSWORD")
    with py7zr.SevenZipFile(archive, mode="r", password=password) as source:
        file_members = [
            name for name in source.getnames() if PurePosixPath(name).name == expected_name
        ]
        if len(file_members) != 1:
            raise RuntimeError(
                f"{archive.name} must contain exactly one {expected_name}; found {file_members}"
            )
        source.extract(path=target_dir, targets=file_members)

    extracted = list(target_dir.rglob(expected_name))
    if len(extracted) != 1:
        raise RuntimeError(f"Cannot locate extracted {expected_name} in {target_dir}")
    if extracted[0] != expected:
        extracted[0].replace(expected)
    return expected


def csv_to_raw_parquet(csv_path: Path, raw_path: Path, scratch: Path) -> None:
    if is_parquet(raw_path):
        return
    if raw_path.exists():
        raise RuntimeError(f"Incomplete raw parquet must be removed manually: {raw_path}")

    scratch.mkdir(parents=True, exist_ok=True)
    fields = "row_number() OVER () AS source_row, " + ", ".join(
        f'"{source}" AS {target}'
        for source, target in zip(
            COLUMNS,
            ["event_id", "channel_id", "date", "time", "alarm", "value"],
            strict=True,
        )
    )
    force = ", force_not_null=[" + ",".join(map(sql_literal, COLUMNS)) + "]"
    options = (
        "all_varchar=true, header=true, delim=',', parallel=false, "
        "strict_mode=true, ignore_errors=false"
    )
    partial = raw_path.with_suffix(".partial.parquet")
    partial.unlink(missing_ok=True)
    config = {
        "memory_limit": "1GB",
        "threads": 2,
        "temp_directory": str(scratch),
        "max_temp_directory_size": "12GB",
        "preserve_insertion_order": False,
        "autoinstall_known_extensions": False,
    }
    try:
        with duckdb.connect(config=config) as connection:
            connection.execute(
                "COPY (SELECT "
                + fields
                + " FROM read_csv("
                + sql_literal(csv_path)
                + ", "
                + options
                + force
                + ")) TO "
                + sql_literal(partial)
                + " (FORMAT PARQUET, COMPRESSION ZSTD)"
            )
        if not is_parquet(partial):
            raise RuntimeError(f"DuckDB produced an invalid parquet: {partial}")
        partial.replace(raw_path)
    finally:
        partial.unlink(missing_ok=True)


def write_json_atomic(path: Path, payload: object) -> None:
    partial = path.with_suffix(path.suffix + ".partial")
    partial.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    partial.replace(path)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Build Contour ML yearly parquet files from the organizer archives"
    )
    parser.add_argument("--source", type=Path, required=True)
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--cache", type=Path, required=True)
    args = parser.parse_args()

    source = args.source.resolve()
    repo = args.repo.resolve()
    output = args.output.resolve()
    cache = args.cache.resolve()
    if not source.is_dir():
        raise FileNotFoundError(source)
    output.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)

    expected = load_expected_archives(repo)
    archives = verify_archives(source, expected)
    official_prepare = load_official_prepare(repo)

    for archive in archives:
        year = int(archive.stem.rsplit("-", 1)[1])
        target = output / f"{year}.parquet"
        if target.exists():
            if not is_parquet(target):
                raise RuntimeError(f"Existing output is not a valid parquet: {target}")
            print(
                json.dumps(
                    {"year": year, "status": "already_prepared", "bytes": target.stat().st_size}
                ),
                flush=True,
            )
            continue

        if shutil.disk_usage(cache).free < MIN_FREE_BYTES:
            raise RuntimeError(f"Less than 8 GiB free in cache filesystem: {cache}")

        started = time.monotonic()
        year_cache = cache / str(year)
        csv_path = extract_csv(archive, year_cache / "extracted")
        raw_path = year_cache / f"{year}.raw.parquet"
        csv_to_raw_parquet(csv_path, raw_path, year_cache / "duckdb-spill")
        report = official_prepare(raw_path, target, year in DEDUPLICATED_YEARS)
        if not is_parquet(target):
            raise RuntimeError(f"Official prepare produced an invalid parquet: {target}")

        write_json_atomic(output / f"{year}.preparation.json", report)
        shutil.rmtree(year_cache)
        print(
            json.dumps(
                {
                    "year": year,
                    "status": "prepared",
                    "bytes": target.stat().st_size,
                    "elapsed_seconds": round(time.monotonic() - started, 1),
                    **report,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )

    prepared = [output / f"{year}.parquet" for year in YEARS]
    invalid = [str(path) for path in prepared if not is_parquet(path)]
    if invalid:
        raise RuntimeError(f"Prepared dataset is incomplete: {invalid}")
    print(
        json.dumps(
            {
                "status": "complete",
                "files": [
                    {"name": path.name, "bytes": path.stat().st_size} for path in prepared
                ],
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


if __name__ == "__main__":
    main()
