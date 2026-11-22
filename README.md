[![Build a static site faster](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![Rank](https://make.fun/badge/site-generator-speed-01-run-20261122/khaliefk/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![Reward](https://make.fun/badge/site-generator-speed-01-run-20261122/khaliefk/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

# site-generator-speed-01-run-20261122

A faster drop-in for makefun-site 1.0.0. `solve.js` answers every input exactly
as makefun-site does: same pages, same index and tag pages, same build report,
byte for byte, including its front matter rules, template dialect, Markdown
subset, slug rule and broken-link reports. `main.ts` is the harness driver: it
reads `/input/cases.json`, answers each case with `run()`, and writes
`/output/answers.json`. Dependency-free, no network, no WASM, no native code.

The speed comes from small cuts that add up: the Markdown inline pass jumps
from one markup character to the next instead of reading one character at a
time, slugs are cached per case and skip Unicode normalisation for plain
ASCII, front matter is walked line by line without splitting the body,
templates compile to plain functions, and cards and word counts are worked
out once per source.

On the practice set (3 cases, about 2.9 MB of input) it answers all 3 cases
identically to the reference and runs about 2.8x faster than the house
baseline on this machine; see the verification numbers in the entry report.
