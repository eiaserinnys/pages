#!/usr/bin/env python3
"""Set pages Cloudflare Worker secrets from a dotenv file or environment."""

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path


SECRET_KEYS = [
    "PAGES_API_TOKEN",
    "SESSION_SECRET",
    "GOOGLE_CLIENT_ID",
    "GOOGLE_CLIENT_SECRET",
]


def parse_dotenv(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.split(" #", 1)[0].strip().strip("\"").strip("'")
        values[key.strip()] = value
    return values


def read_secret_values(source_env: Path | None) -> dict[str, str]:
    source_values = parse_dotenv(source_env) if source_env else {}
    values: dict[str, str] = {}
    missing: list[str] = []
    for key in SECRET_KEYS:
        value = source_values.get(key) if source_env else None
        if not value:
            value = os.getenv(key)
        if not value:
            missing.append(key)
        else:
            values[key] = value
    if missing:
        raise SystemExit(f"Missing required secret values: {', '.join(missing)}")
    return values


def put_secret(key: str, value: str, wrangler_version: str) -> None:
    cmd = ["npx", "--yes", f"wrangler@{wrangler_version}", "secret", "put", key]
    proc = subprocess.run(
        cmd,
        input=value + "\n",
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        check=False,
    )
    safe_output = "\n".join(line for line in proc.stdout.splitlines() if value not in line)
    if safe_output:
        print(safe_output)
    if proc.returncode != 0:
        raise SystemExit(proc.returncode)


def main() -> None:
    parser = argparse.ArgumentParser(description="Set Cloudflare Worker secrets for pages.")
    parser.add_argument("--source-env", type=Path, help="dotenv file containing existing pages secrets")
    parser.add_argument("--wrangler-version", default="4.86.0")
    args = parser.parse_args()

    values = read_secret_values(args.source_env)
    for key, value in values.items():
        print(f"Setting {key} ({len(value)} chars)")
        put_secret(key, value, args.wrangler_version)


if __name__ == "__main__":
    main()
