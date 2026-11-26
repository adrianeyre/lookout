---
status: accepted
---

# The project website is a static page in `site/`, published by GitHub Pages

[Lookout](https://github.com/adrianeyre/lookout)'s public website (`lookout.adrianeyre.co.uk`) is a single static page. Its source is in `site/` in the main repo, Vite builds it, and a GitHub Actions workflow publishes it to GitHub Pages. This is the same pattern as the ai-office project website. Keeping it in the main repo means the site reuses the screenshot harness's images from `docs/images/` without copies, and a pull request that changes a feature can update the site in the same review. GitHub Pages costs nothing and needs no server.

## Considered Options

- **A separate website repo:** keeps the main repo smaller, but screenshots, logos and wording drift out of sync with the app.
- **A docs framework (Docusaurus, VitePress, Starlight):** good for many pages, but Lookout needs one marketing and setup page, and a framework adds a theme and a dependency tree to maintain.
- **Hosting on the Host itself:** a public site on the server that Lookout says must never be public.

## Consequences

- The domain and repo URL are each defined once in `site/build.ts`. Renaming the repo later only means changing that constant.
- The site must have no analytics, cookies or third-party requests. Its screenshots come only from fake fixture data, never from a real Host.
