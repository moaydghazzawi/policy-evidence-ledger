from __future__ import annotations

import argparse
import os
from pathlib import Path

import uvicorn

from .seed import seed_demo
from .storage import LedgerStore


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        prog="policy-evidence-ledger",
        description="Run or seed the local Policy Evidence Ledger.",
    )
    result.add_argument("command", choices=["serve", "seed"], nargs="?", default="serve")
    result.add_argument("--instance-dir", type=Path)
    result.add_argument(
        "--host",
        choices=["127.0.0.1", "localhost"],
        default="127.0.0.1",
        help="Loopback address only; the MVP is not a network service.",
    )
    result.add_argument("--port", type=int, default=8000)
    result.add_argument("--no-auto-seed", action="store_true")
    return result


def main() -> None:
    args = parser().parse_args()
    configured_instance = args.instance_dir or Path(os.environ.get("PEL_INSTANCE_DIR", "instance"))
    instance = configured_instance.expanduser().resolve()
    if args.command == "seed":
        created = seed_demo(LedgerStore(instance / "ledger.sqlite3", instance / "blobs"))
        print(
            "Demo corpus seeded."
            if created
            else "Database already contains sources; no changes made."
        )
        return

    os.environ["PEL_INSTANCE_DIR"] = str(instance)
    if args.no_auto_seed:
        os.environ["PEL_AUTO_SEED"] = "false"
    uvicorn.run("policy_evidence_ledger.app:app", host=args.host, port=args.port, reload=False)


if __name__ == "__main__":
    main()
