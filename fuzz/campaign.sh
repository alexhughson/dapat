#!/bin/sh
# The full campaign: each line is one process; summaries go to $OUT, then aggregate.ts sums them.
# Run: sh fuzz/campaign.sh <out-dir>
OUT=${1:-/tmp/dapat-fuzz-campaign}
mkdir -p "$OUT"
cd "$(dirname "$0")/.." || exit 1
bun fuzz/run.ts --scenario pattern --from 1 --to 700 --out "$OUT/pattern-1.json" &
bun fuzz/run.ts --scenario pattern --from 701 --to 1400 --out "$OUT/pattern-2.json" &
( bun fuzz/run.ts --scenario join-mem --from 1 --to 10000 --out "$OUT/join-mem.json" ;
  bun fuzz/run.ts --scenario fs --from 3001 --to 6000 --out "$OUT/fs-2.json" ) &
bun fuzz/run.ts --scenario fs --from 1 --to 3000 --out "$OUT/fs-1.json" &
wait
bun fuzz/aggregate.ts "$OUT"/*.json > "$OUT/total.json"
echo "campaign done: $OUT/total.json"
