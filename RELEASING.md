# RELEASING.md — How to publish `@rachael/cu`

Actual publish to npm / PyPI is gated on owner approval and is **not**
performed automatically. This document captures the dry-run sequence
that has been exercised in CI, and the publish sequence the owner runs
when ready.

## Pre-flight

- All packages share `version = 0.1.0` for the initial release.
  Bumping is coordinated; do not ship one package at a different
  major.
- `peerDependencies` ranges in cu-browser / cu-windows / cu-router /
  cu-skills / cu-bench all point to `^0.1.0` of cu-core.
- The boundary lint must pass: `tsx scripts/check-package-boundaries.ts`
  exits 0.
- The bench harness must pass: `tsx packages/cu-bench/run.ts`.

## TS packages — `npm pack` dry-run

For each TS package directory:

```bash
cd packages/cu-core           && npm pack --dry-run
cd packages/cu-browser        && npm pack --dry-run
cd packages/cu-windows        && npm pack --dry-run
cd packages/cu-router         && npm pack --dry-run
cd packages/cu-skills         && npm pack --dry-run
cd packages/cu-inspector-data && npm pack --dry-run
cd packages/cu-bench          && npm pack --dry-run
```

The dry-run output (file list per package) is captured under
`packages/cu-bench/raw/npm-pack-dryrun.txt` so the file manifests are
reviewable in PR.

### Standalone import smoke test

```bash
bash scripts/check-package-smoke.sh
```

For each package, this packs the tarball, extracts it to a temp
directory, links **only the declared peer dependencies**, and imports
the entrypoint via `tsx`. Catches the class of bug where a packaged
file imports a relative path that doesn't exist in the tarball
(e.g. an accidental `../../cu-core/bench/harness` reference). Must
print `[smoke] OK — all 7 tarballs import cleanly` before publish.

### What to verify in each dry-run



- `package.json`, `README.md`, `NON_GOALS.md`, `src/**`, `examples/**`
  are present.
- No `tests/`, no `node_modules`, no source maps from upstream
  packages.
- For `@rachael/cu-windows`, the `python/` directory **is**
  included (it ships alongside the TS adapters as a convenience).

## Python sidecar — `python -m build` dry-run

```bash
cd packages/cu-windows/python
python -m build --sdist --wheel
```

Output goes to `dist/` under the python directory. Verify:

- `rachael_cu_windows-0.1.0.tar.gz` is present.
- `rachael_cu_windows-0.1.0-py3-none-any.whl` is present.
- The wheel includes `som_detector.py`, `uia_bridge.py`, `schema.py`,
  and `__init__.py`.

## Publish sequence (owner only)

```bash
# TS packages
for p in cu-core cu-router cu-skills cu-browser cu-windows cu-inspector-data cu-bench; do
  ( cd packages/$p && npm publish --access public )
done

# Python sidecar
( cd packages/cu-windows/python && python -m build && twine upload dist/* )
```

`@rachael` scope on npm requires the `--access public` flag for the
first publish of a scoped package.

## Tagging

After publish:

```bash
git tag cu-v0.1.0 -m "Initial public release of the @rachael/cu SDK"
git push origin cu-v0.1.0
```

Do not move the tag once published.

## What changes after the first publish

- The umbrella re-export in `@rachael/cu-core` (router/skills/adapter
  symbols) is **deprecated** in v0.2.0 and **removed** in v1.0.0.
  Internal Rachael code should migrate per `MIGRATION.md`.
- The cu-inspector-data trajectory schemas become the source of truth;
  `shared/trajectory-types.ts` becomes a thin re-export.
- `@rachael/cu-bench` becomes the canonical place to add new benchmark
  task suites; the `bench/` folder under cu-core moves there
  physically.
