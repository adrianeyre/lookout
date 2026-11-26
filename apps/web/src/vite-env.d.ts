/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Shown in the footer: the release build's, or the root package.json's (vite.config.ts). */
  readonly VITE_LOOKOUT_VERSION: string;
  /** CHANGELOG.md as safe, escaped HTML, rendered at build time (vite.config.ts). */
  readonly VITE_LOOKOUT_CHANGELOG_HTML?: string;
}
