# Third-party notices

## Brand assets

The Lookout logo, icon, favicon, PWA icons and `og-image.png` (`apps/web/src/brand/` and
`apps/web/public/`) are original to this project. They use no third-party marks.

The logo's wordmark and the Open Graph image set their text in the reader's own sans-serif
system font (`Inter, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`). No typeface
is embedded or distributed with them, so no font licence applies.

The telescope mark, in the app and on the Project Website (`site/brand/` and `site/public/`),
is original to this project.

## Icons (Project Website)

The Project Website's line icons are drawn after [Lucide](https://lucide.dev) (ISC licence,
Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part of Feather (MIT);
all other copyright (c) for Lucide are held by Lucide Contributors 2022). The GitHub mark is from
[Octicons](https://github.com/primer/octicons) (MIT licence, Copyright (c) 2023 GitHub Inc.) and
is used to link to the project's GitHub repository, as GitHub's logo guidelines allow.

## Fonts (Project Website)

The Project Website (`site/`) self-hosts two typefaces. They are not part of the Lookout Image.
The build copies each font file from its npm package together with its licence, which is
published beside it on the site (`/fonts/Inter-OFL.txt`, `/fonts/JetBrainsMono-OFL.txt`).

| Typeface                                | Source                                                                                                           | Licence                                                                      |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Inter (variable, Latin subset)          | [rsms/inter](https://github.com/rsms/inter), via `@fontsource-variable/inter`                                    | SIL Open Font License 1.1. Copyright 2016 The Inter Project Authors          |
| JetBrains Mono (variable, Latin subset) | [JetBrains/JetBrainsMono](https://github.com/JetBrains/JetBrainsMono), via `@fontsource-variable/jetbrains-mono` | SIL Open Font License 1.1. Copyright 2020 The JetBrains Mono Project Authors |

## Stageshow kit (Project Website)

The Project Website's hero demo (`site/demos/`) is built on the React kit from the
[Stageshow skill](https://github.com/benjitaylor/skills/tree/main/stageshow) by Benji Taylor,
version 1.1.1, vendored unmodified in `site/stageshow/`. It is not part of the Lookout Image.

| Component           | Source                                                                                     | Licence                              |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------ |
| Stageshow kit 1.1.1 | [benjitaylor/skills: stageshow](https://github.com/benjitaylor/skills/tree/main/stageshow) | MIT. Copyright (c) 2026 Benji Taylor |

Its licence and notices are kept beside it (`site/stageshow/LICENSE`, `site/stageshow/NOTICE.md`).
The kit's own brand artwork (`site/stageshow/kit/brands/`, sources and licences in its
`SOURCES.md`) is kept as published but is not used: the demo imports only the kit modules it
needs, so no third-party mark is bundled into the site. The demo shows only Lookout's own logo.

## npm packages

Lookout's runtime and development dependencies are listed in `pnpm-lock.yaml`. Each package's
licence is in its own `package.json` and `LICENSE` file under `node_modules/`.
