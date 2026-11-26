# Stageshow kit (vendored)

The React kit from the [Stageshow skill](https://github.com/benjitaylor/skills/tree/main/stageshow)
by Benji Taylor, version 1.1.1 (commit `299140fafd08df55a9c234e610c3f64af3f45531`), MIT licensed
(see `LICENSE` and `NOTICE.md`). The Project Website's hero demo (`site/demos/`, PRD WEB-5) is
built on it.

`kit/` is copied as published, **unmodified**. It is restyled only from `site/demos/`
(`look.css` maps Lookout's design tokens onto the kit's `--ss-*` tokens), never by editing it, so
a newer copy can replace it whole. ESLint and Prettier leave it alone (`eslint.config.js`,
`.prettierignore`), and `site/demos/tsconfig.json` type-checks the modules the demo uses under the
kit's own plain `strict` settings.

The demo imports kit modules one by one (`site/demos/kit.ts`), not the kit's index, so only those
are bundled: the kit's brand artwork in `kit/brands/` (sources and licences in
`kit/brands/SOURCES.md`) and its icon set are kept as published but never reach the site.

`SHA256SUMS` holds the SHA-256 of every file in `kit/`, `LICENSE` and `NOTICE.md`, and
`site/stageshow.test.ts` fails if any file differs from it, or if a file is added or removed. On
25 November 2026 every file was checked against the upstream commit above (git blob hashes from
GitHub's tree API, `git hash-object` here): all 155 kit files, `LICENSE` and `NOTICE.md` match
(pen-test finding #130).

To update: copy `kit/`, `LICENSE` and `NOTICE.md` from a newer release over these, note the
version and commit here, check each file against that commit as above, then regenerate the sums:

```sh
cd site/stageshow && (find kit -type f; echo LICENSE; echo NOTICE.md) | LC_ALL=C sort | xargs shasum -a 256 > SHA256SUMS
```

and run `pnpm typecheck`, `pnpm test`, `pnpm site:build` and `pnpm site:check`.
