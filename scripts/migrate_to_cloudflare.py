#!/usr/bin/env python3
"""Migrate the existing Express pages store to Cloudflare D1 and private R2."""

from __future__ import annotations

import argparse
import json
import mimetypes
import os
import sqlite3
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_DATABASE_ID = "af7049be-6ba5-4261-bc05-e5773d3eec33"
DEFAULT_BUCKET = "pages-content"
DEFAULT_SOURCE_DIR = "/home/eias/services/pages/shared/pages"
TABLES = [
    ("documents", ["doc_id", "slug", "title", "owner", "latest_revision", "created_at", "updated_at"]),
    ("revisions", ["rev_id", "doc_id", "rev_number", "status", "created_at"]),
    ("comments", ["comment_id", "rev_id", "anchor", "body", "author", "created_at", "resolved", "payload_json", "updated_at"]),
    ("webhook_secrets", ["rev_id", "secret", "secret_hash", "created_at", "updated_at"]),
    ("revision_bundles", ["rev_id", "entrypoint", "file_count", "total_size_bytes", "created_at"]),
    ("revision_assets", ["rev_id", "path", "bytes_key", "content_type", "size_bytes", "created_at"]),
]


def ensure_boto3():
    try:
        import boto3  # type: ignore
        from botocore.config import Config  # type: ignore
        return boto3, Config
    except ImportError:
        subprocess.check_call([sys.executable, "-m", "pip", "install", "boto3", "-q"])
        import boto3  # type: ignore
        from botocore.config import Config  # type: ignore
        return boto3, Config


def required_env(name: str) -> str:
    value = os.getenv(name)
    if not value:
        raise SystemExit(f"Missing environment variable: {name}")
    return value


class D1Client:
    def __init__(self, account_id: str, api_token: str, database_id: str) -> None:
        self.url = f"https://api.cloudflare.com/client/v4/accounts/{account_id}/d1/database/{database_id}/query"
        self.headers = {
            "Authorization": f"Bearer {api_token}",
            "Content-Type": "application/json",
        }

    def execute(self, sql: str, params: list[Any] | None = None, retries: int = 3) -> Any:
        body = json.dumps({"sql": sql, "params": params or []}, ensure_ascii=False).encode("utf-8")
        for attempt in range(1, retries + 1):
            req = urllib.request.Request(self.url, data=body, headers=self.headers, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=30) as resp:
                    payload = json.loads(resp.read().decode("utf-8"))
                if not payload.get("success"):
                    raise RuntimeError(payload)
                for result in payload.get("result", []):
                    if not result.get("success"):
                        raise RuntimeError(result)
                return payload
            except (urllib.error.URLError, RuntimeError) as exc:
                if attempt == retries:
                    raise
                wait = 0.5 * attempt
                print(f"D1 query failed, retrying in {wait:.1f}s: {exc}")
                time.sleep(wait)
        raise AssertionError("unreachable")


def create_r2_client():
    boto3, Config = ensure_boto3()
    return boto3.client(
        "s3",
        endpoint_url=required_env("PAGES_R2_ENDPOINT"),
        aws_access_key_id=required_env("PAGES_R2_ACCESS_KEY_ID"),
        aws_secret_access_key=required_env("PAGES_R2_SECRET_ACCESS_KEY"),
        region_name="auto",
        config=Config(signature_version="s3v4", retries={"max_attempts": 3}),
    )


def apply_schema(d1: D1Client, migrations_dir: Path) -> None:
    for path in sorted(migrations_dir.glob("*.sql")):
        print(f"Applying schema: {path.name}")
        d1.execute(path.read_text(encoding="utf-8"))


def row_dicts(conn: sqlite3.Connection, table: str, columns: list[str]) -> list[dict[str, Any]]:
    conn.row_factory = sqlite3.Row
    rows = conn.execute(f"SELECT {', '.join(columns)} FROM {table}").fetchall()
    return [dict(row) for row in rows]


def normalize_row(table: str, row: dict[str, Any]) -> dict[str, Any]:
    if table == "revision_assets" and not str(row["bytes_key"]).startswith("bundles/"):
        row = dict(row)
        row["bytes_key"] = f"bundles/{row['bytes_key']}"
    return row


def migrate_table(d1: D1Client, conn: sqlite3.Connection, table: str, columns: list[str], dry_run: bool) -> int:
    rows = row_dicts(conn, table, columns)
    if dry_run:
        print(f"D1 dry-run: {table} rows={len(rows)}")
        return len(rows)
    placeholders = ", ".join(["?"] * len(columns))
    sql = f"INSERT OR REPLACE INTO {table} ({', '.join(columns)}) VALUES ({placeholders})"
    for index, row in enumerate(rows, start=1):
        normalized = normalize_row(table, row)
        d1.execute(sql, [normalized[column] for column in columns])
        if index % 100 == 0:
            print(f"  {table}: {index}/{len(rows)}")
    print(f"D1 migrated: {table} rows={len(rows)}")
    return len(rows)


def content_type(path: Path) -> str:
    if path.suffix == ".json":
        return "application/json; charset=utf-8"
    if path.suffix in {".html", ".htm"}:
        return "text/html; charset=utf-8"
    return mimetypes.guess_type(str(path))[0] or "application/octet-stream"


def put_file(s3: Any, bucket: str, source: Path, key: str, dry_run: bool) -> None:
    if dry_run:
        return
    s3.upload_file(
        str(source),
        bucket,
        key,
        ExtraArgs={
            "ContentType": content_type(source),
            "CacheControl": "private, max-age=60",
        },
    )


def migrate_r2_files(s3: Any, bucket: str, source_dir: Path, conn: sqlite3.Connection, dry_run: bool) -> tuple[int, int]:
    page_count = 0
    for path in sorted(list(source_dir.glob("*.json")) + list(source_dir.glob("*.html"))):
        put_file(s3, bucket, path, f"pages/{path.name}", dry_run)
        page_count += 1
        if page_count % 200 == 0:
            print(f"  R2 page files: {page_count}")

    bundle_count = 0
    for row in row_dicts(conn, "revision_assets", ["bytes_key"]):
        old_key = row["bytes_key"]
        source = source_dir / "bundles" / old_key
        if not source.exists():
            raise FileNotFoundError(f"Missing bundle file: {source}")
        put_file(s3, bucket, source, f"bundles/{old_key}", dry_run)
        bundle_count += 1
        if bundle_count % 100 == 0:
            print(f"  R2 bundle files: {bundle_count}")

    print(f"R2 {'dry-run' if dry_run else 'migrated'}: page_files={page_count}, bundle_files={bundle_count}")
    return page_count, bundle_count


def main() -> None:
    parser = argparse.ArgumentParser(description="Migrate pages Express data to Cloudflare D1/R2.")
    parser.add_argument("--source-dir", type=Path, default=Path(os.getenv("PAGES_SOURCE_DIR", DEFAULT_SOURCE_DIR)))
    parser.add_argument("--database-id", default=os.getenv("PAGES_D1_DATABASE_ID", DEFAULT_DATABASE_ID))
    parser.add_argument("--bucket", default=os.getenv("PAGES_R2_BUCKET", DEFAULT_BUCKET))
    parser.add_argument("--migrations-dir", type=Path, default=Path("migrations"))
    parser.add_argument("--apply-schema", action="store_true")
    parser.add_argument("--skip-d1", action="store_true")
    parser.add_argument("--skip-r2", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    source_dir = args.source_dir
    db_path = source_dir / "pages-meta.sqlite"
    if not db_path.exists():
        raise SystemExit(f"Missing SQLite metadata DB: {db_path}")

    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    try:
        if not args.skip_d1:
            d1 = D1Client(
                account_id=required_env("CLOUDFLARE_ACCOUNT_ID"),
                api_token=required_env("CLOUDFLARE_API_TOKEN"),
                database_id=args.database_id,
            )
            if args.apply_schema:
                if args.dry_run:
                    print(f"D1 dry-run: would apply schema from {args.migrations_dir}")
                else:
                    apply_schema(d1, args.migrations_dir)
            for table, columns in TABLES:
                migrate_table(d1, conn, table, columns, args.dry_run)

        if not args.skip_r2:
            s3 = create_r2_client()
            migrate_r2_files(s3, args.bucket, source_dir, conn, args.dry_run)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
