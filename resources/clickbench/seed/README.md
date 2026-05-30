# Click-bench seed benchmarks

Five PLACEHOLDER benchmarks shipped with the app. None have ground
truth filled in — every user's monitor layout is different, so the
correct coordinates are inherently per-machine.

## How to make these meaningful

1. Open VoidSoul → Settings → Advanced → Experimental → Click Benchmark.
2. Click "Capture" next to one of these entries.
3. The capture overlay walks you through: set up the target app, take
   the screenshot, click the target's centre, drag a bounding box
   around the target.
4. Re-running the bench now scores every strategy against your captured
   ground truth.

## Adding your own

Use "New benchmark" in the same dialog. Stored locally at
`<userData>/clickbench/benchmarks/<id>.json` and gitignored — your
ground-truth coords stay on your machine, but the schema is
shareable if you want to swap with a collaborator.

## Categories

- `labeled-native` — native button with a UIA label (UIA's strong case)
- `icon-only-native` — native icon-only button (UIA label coverage gap)
- `browser-web` — chat / web-app button inside a browser (UIA opaque)
- `menu-item` — popup or right-click menu items
- `panel-selector` — sidebar / nav-rail entries
