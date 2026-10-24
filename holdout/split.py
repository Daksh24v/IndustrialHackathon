"""Lock an 80/20 split of the train+dev buildings: 'build' for developing, 'holdout' for honest checks.

Split by group_id (all buildings of one site land on the same side), stratified by source, fixed seed.
Run once; the lists are committed and must not change afterwards:  uv run python -m holdout.split
"""

import csv
import random
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MANIFEST = ROOT / "data" / "manifest.csv"
BUILD_LIST = Path(__file__).resolve().parent / "build.txt"
HOLDOUT_LIST = Path(__file__).resolve().parent / "holdout.txt"
SEED = 20261024
HOLDOUT_SHARE = 0.2


def split() -> tuple[list[str], list[str]]:
    with MANIFEST.open(encoding="utf-8", newline="") as handle:
        rows = [row for row in csv.DictReader(handle) if row["split"] in ("train", "dev")]
    groups_by_source: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        groups_by_source[row["source"]][row["group_id"]].append(row["building_id"])
    rng = random.Random(SEED)
    build, holdout = [], []
    for source in sorted(groups_by_source):
        groups = sorted(groups_by_source[source])
        rng.shuffle(groups)
        cut = round(len(groups) * HOLDOUT_SHARE)
        for index, group in enumerate(groups):
            (holdout if index < cut else build).extend(groups_by_source[source][group])
    return sorted(build), sorted(holdout)


def read(path: Path) -> set[str]:
    return {line.strip() for line in path.read_text(encoding="utf-8").splitlines() if line.strip()}


def main() -> None:
    if BUILD_LIST.exists() or HOLDOUT_LIST.exists():
        raise SystemExit("The split is locked already; delete the lists only if you mean to re-split.")
    build, holdout = split()
    BUILD_LIST.write_text("\n".join(build) + "\n", encoding="utf-8")
    HOLDOUT_LIST.write_text("\n".join(holdout) + "\n", encoding="utf-8")
    print(f"build {len(build)}, holdout {len(holdout)}")


if __name__ == "__main__":
    main()
