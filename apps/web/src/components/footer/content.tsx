import icon from '../../brand/icon.svg';
import type { ReactNode } from 'react';

/** The source, named once for the footer. */
export const REPO_URL = 'https://github.com/adrianeyre/lookout';

/** A link to another site: it opens in a new tab, so the dashboard stays open. */
function External({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
      <span className="visually-hidden">, opens in a new tab</span>
    </a>
  );
}

/** CHANGELOG.md, rendered and escaped at build time (vite.config.ts). */
export function Changelog() {
  const html = import.meta.env.VITE_LOOKOUT_CHANGELOG_HTML;
  if (!html) {
    return (
      <div className="prose">
        <p>This build has no changelog.</p>
        <p>
          Every release is listed on{' '}
          <External href={`${REPO_URL}/releases`}>GitHub Releases</External>.
        </p>
      </div>
    );
  }
  // Safe: renderChangelog escapes all text and keeps only http(s) links.
  return <div className="prose changelog" dangerouslySetInnerHTML={{ __html: html }} />;
}

interface Credit {
  name: string;
  what: string;
  licence: string;
  href: string;
}

/** What the dashboard is built with, grouped by the part of it each one does. */
const CREDIT_GROUPS: { title: string; credits: Credit[] }[] = [
  {
    title: 'The dashboard',
    credits: [
      { name: 'React', what: 'The user interface', licence: 'MIT', href: 'https://react.dev' },
      {
        name: 'Fastify',
        what: 'The server and its API',
        licence: 'MIT',
        href: 'https://fastify.dev',
      },
      {
        name: 'Node.js',
        what: 'Runs the server, and hashes the password with Argon2id',
        licence: 'MIT',
        href: 'https://nodejs.org',
      },
    ],
  },
  {
    title: 'Build and test',
    credits: [
      { name: 'Vite', what: 'Builds the interface', licence: 'MIT', href: 'https://vite.dev' },
      {
        name: 'TypeScript',
        what: 'The language it is written in',
        licence: 'Apache-2.0',
        href: 'https://www.typescriptlang.org',
      },
      { name: 'Vitest', what: 'Unit tests', licence: 'MIT', href: 'https://vitest.dev' },
      {
        name: 'Testing Library',
        what: 'Component tests',
        licence: 'MIT',
        href: 'https://testing-library.com',
      },
      {
        name: 'Playwright',
        what: 'Browser tests and the screenshots',
        licence: 'Apache-2.0',
        href: 'https://playwright.dev',
      },
      {
        name: 'axe-core',
        what: 'Automated accessibility checks',
        licence: 'MPL-2.0',
        href: 'https://github.com/dequelabs/axe-core',
      },
      {
        name: 'sharp',
        what: 'Renders the icons',
        licence: 'Apache-2.0',
        href: 'https://sharp.pixelplumbing.com',
      },
    ],
  },
];

export function Credits() {
  return (
    <div className="prose">
      <section className="creator" aria-labelledby="credits-creator">
        <span className="creator__logo" aria-hidden="true">
          <img src={icon} alt="" width="48" height="48" />
        </span>
        <div>
          <h3 id="credits-creator">Adrian Eyre</h3>
          <p>Created, designed and built Lookout.</p>
          <p className="muted">
            <External href="https://github.com/adrianeyre">On GitHub</External>
          </p>
        </div>
      </section>
      <p>
        Lookout is built on open-source software. Thank you to everyone who makes it. The full list
        is in{' '}
        <External href={`${REPO_URL}/blob/main/THIRD-PARTY-NOTICES.md`}>
          THIRD-PARTY-NOTICES.md
        </External>
        .
      </p>
      {CREDIT_GROUPS.map((group) => (
        <section key={group.title} aria-label={group.title}>
          <h3>{group.title}</h3>
          <ul className="credits">
            {group.credits.map((credit) => (
              <li key={credit.name}>
                <span>
                  <External href={credit.href}>{credit.name}</External>{' '}
                  <span className="muted">{credit.what}</span>
                </span>
                <span className="credits__licence">
                  <span className="visually-hidden">Licence: </span>
                  {credit.licence}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** When the policies last changed; shown at the top of each. */
const UPDATED = 'Last updated: November 2026';

export function PrivacyPolicy() {
  return (
    <div className="prose">
      <p className="policy-updated">{UPDATED}</p>

      <h3>Who looks after your data</h3>
      <p>
        Lookout is self-hosted. Whoever runs it on this server (its operator) decides what it can
        see and who can sign in, and is responsible for it. The software sends nothing to its
        author: there is no analytics, no tracking, no advertising and no telemetry, and this page
        loads nothing from any other site.
      </p>

      <h3>What Lookout keeps</h3>
      <ul>
        <li>
          <strong>Sign-in</strong> — the password only as an Argon2id hash, in the settings the
          operator gives it, never the password itself. A session lives only in its signed cookie (a
          random ID and when it was last used); logging out adds that ID to a list in memory until
          it would have expired anyway.
        </li>
        <li>
          <strong>Failed sign-ins</strong> — how many each IP address has made in the last 15
          minutes, in memory, to stop more than 5.
        </li>
        <li>
          <strong>What it shows</strong> — Host Metrics, Container details and stats, website check
          results, and the latest scan of the largest folders (their names and sizes only; files are
          never opened), in memory only, with at most the Live Window of history (15 minutes by
          default, up to 60). Nothing is written to disk, and it is all gone when Lookout restarts.
        </li>
        <li>
          <strong>Logs and environment values</strong> — Container logs are streamed from Docker as
          you read them and kept only in this browser tab. An environment value is fetched only when
          you reveal it, and forgotten when you hide it.
        </li>
        <li>
          <strong>The server’s log</strong> — each request’s method, path, the IP address it came
          from and its result; failed sign-ins with their IP address; and each Container Action and
          revealed environment variable, by name, never its value. Cookies and authorization headers
          are removed. The log goes to Docker, which keeps it as its log settings say.
        </li>
        <li>
          <strong>In this browser</strong> — your Settings (mode and theme) and where you put each
          Widget, in local storage. They never leave your browser.
        </li>
      </ul>

      <h3>Who else sees it</h3>
      <p>Lookout talks to nobody but these, and only to do what it shows you:</p>
      <ul>
        <li>
          <strong>Docker</strong> — on this server, through its socket or the optional socket proxy,
          to list Containers, read their stats, logs and details, and start, stop, restart or remove
          them when you ask.
        </li>
        <li>
          <strong>Your websites</strong> — the Hosted Sites found from Traefik or{' '}
          <code>lookout.url</code> labels or listed in <code>LOOKOUT_SITES</code>: one{' '}
          <code>GET</code> each check, reading only the status, headers and certificate, never the
          page itself.
        </li>
      </ul>
      <p>
        Links in this footer open GitHub, in a new tab, only when you choose them; GitHub’s own
        privacy statement then applies.
      </p>

      <h3>How long it is kept</h3>
      <p>
        A session lasts until it has not been used for <code>LOOKOUT_SESSION_IDLE_DAYS</code> (7 by
        default), until <code>LOOKOUT_SESSION_MAX_DAYS</code> after you signed in (30 by default),
        or until you log out. Everything held in memory, sessions included, goes when Lookout
        restarts. Your Settings and layouts stay in this browser until you clear its site data.
      </p>

      <h3>Your rights</h3>
      <p>
        Lookout keeps nothing about you beyond the above. To see or remove what the server’s log
        holds, ask the operator of this server.
      </p>
    </div>
  );
}

export function TermsAndConditions() {
  return (
    <div className="prose">
      <p className="policy-updated">{UPDATED}</p>

      <h3>Using Lookout</h3>
      <p>
        Lookout is free and open source under the{' '}
        <External href={`${REPO_URL}/blob/main/LICENSE`}>MIT licence</External>, and is software you
        run yourself. Using this copy of it, you agree to these terms and to any its operator adds.
      </p>

      <h3>Keeping it private</h3>
      <p>
        Lookout has root-equivalent access to this server through Docker: anyone who can sign in can
        start, stop and remove its Containers. Keep it on your LAN or a VPN, never the public
        internet, port-forwarded or behind a public proxy, and keep{' '}
        <code>LOOKOUT_BIND_ADDRESS</code> on a private address.
      </p>

      <h3>Your password</h3>
      <p>
        Use a long, unique password and keep it secret. Anyone you give it to can do everything you
        can, and you are responsible for what is done with it. Changing the password, or{' '}
        <code>LOOKOUT_SESSION_SECRET</code>, or restarting Lookout, signs everyone out.
      </p>

      <h3>Container Actions</h3>
      <p>
        Stop, restart and remove ask first, and remove needs the name typed, but what you do to your
        Containers is yours to check. Removing a Container keeps its volumes; Lookout never removes
        volumes or images, and never acts on itself.
      </p>

      <h3>No warranty</h3>
      <p>
        Lookout is provided as it is, without warranty of any kind. Its author is not liable for any
        loss arising from its use, to the extent the law allows.
      </p>

      <h3>Changes</h3>
      <p>
        These terms may change with new versions of Lookout; the date above says when they last did.
      </p>
    </div>
  );
}

const GRID_PAGES = ['host', 'containers', 'container', 'websites', 'settings'];

const STORAGE = [
  {
    name: 'lookout_session',
    kind: 'Cookie',
    purpose:
      'Keeps you signed in: a random ID, when you signed in and when it was last used, signed by the server. HttpOnly, SameSite=Strict, Path=/, and Secure over HTTPS.',
    lasts:
      'Until unused for LOOKOUT_SESSION_IDLE_DAYS (7 by default), 30 days after signing in, until you log out, or until Lookout restarts',
  },
  {
    name: 'lookout.mode',
    kind: 'Local storage',
    purpose:
      'Light or Dark, when you choose one in Settings. System is the default, kept as nothing.',
    lasts: 'Until you clear this site’s data',
  },
  {
    name: 'lookout.theme',
    kind: 'Local storage',
    purpose: 'The colour theme, when you choose one other than Teal in Settings.',
    lasts: 'Until you clear this site’s data',
  },
  {
    name: 'lookout.grid.<page>',
    kind: 'Local storage',
    purpose: `Where you moved, sized, pinned or hid each Widget, one for each page (${GRID_PAGES.join(', ')}).`,
    lasts: 'Until you choose Reset layout, or clear this site’s data',
  },
] as const;

export function CookiePolicy() {
  return (
    <div className="prose">
      <p className="policy-updated">{UPDATED}</p>

      <h3>Strictly necessary only</h3>
      <p>
        Lookout sets one cookie, only after you sign in, to keep you signed in, and remembers your
        Settings and layouts in this browser’s local storage. All of them are needed for features
        you use, so none needs your consent, and nothing is used for analytics, tracking or
        advertising. There are no third-party cookies. Requests that change something are guarded
        against other sites by the cookie’s <code>SameSite=Strict</code> and a check of where each
        request came from, not by another cookie.
      </p>

      <h3>What is stored</h3>
      <div className="policy-table-box">
        <table className="policy-table">
          <caption className="visually-hidden">Cookies and browser storage Lookout uses</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col">Purpose</th>
              <th scope="col">How long</th>
            </tr>
          </thead>
          <tbody>
            {STORAGE.map(({ name, kind, purpose, lasts }) => (
              <tr key={name}>
                <th scope="row">
                  <code>{name}</code>
                </th>
                <td data-label="Type">{kind}</td>
                <td data-label="Purpose">{purpose}</td>
                <td data-label="How long">{lasts}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h3>Removing them</h3>
      <p>
        Logging out ends your session at once. To remove your Settings and layouts, choose Reset
        layout on a page, or clear this site’s data in your browser; each goes back to its default.
      </p>
    </div>
  );
}

export function AccessibilityStatement() {
  return (
    <div className="prose">
      <p className="policy-updated">Last reviewed: November 2026</p>

      <div className="status-box">
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
        <p>
          <strong>Conformance status:</strong> Lookout is built to meet the Web Content
          Accessibility Guidelines (WCAG) 2.2 at <strong>Level AA</strong>.
        </p>
      </div>

      <h3>What we have done</h3>
      <ul>
        <li>
          <strong>Keyboard access</strong> — every control, menu and dialog works with a keyboard
          alone, with a clear focus outline that the sticky footer and pinned Widgets never hide.
          The Menu and Widgets menus follow the WAI-ARIA menu pattern.
        </li>
        <li>
          <strong>Rearranging</strong> — Widgets move with their grip and the arrow keys, and resize
          with Shift and the arrow keys, as well as by dragging; each change is announced.
        </li>
        <li>
          <strong>Screen readers</strong> — every page has one main heading, each Widget its own
          heading, and every control a name that starts with the words you see. A lost connection to
          the server, and failed actions, are announced.
        </li>
        <li>
          <strong>Colour and contrast</strong> — text has at least 4.5:1 contrast with its
          background, and meters, controls and focus outlines at least 3:1. Warnings and Flagged
          Containers and sites are shown with an icon and words, never colour alone.
        </li>
        <li>
          <strong>Themes</strong> — System, Light or Dark, and six colour themes, in Settings. Every
          combination meets these contrast ratios; a test checks each one.
        </li>
        <li>
          <strong>Motion</strong> — Widgets tilt while dragged, glide when moved and shake briefly
          beside one dropped, and nothing moves when your device asks for reduced motion.
        </li>
        <li>
          <strong>Zoom and reflow</strong> — pages fit screens 360 pixels wide with no sideways
          scrolling, and reflow when zoomed, Widgets stacking in order; wide tables and logs scroll
          on their own rather than the page.
        </li>
        <li>
          <strong>Target sizes</strong> — every control is at least 24 by 24 pixels, and most are 40
          or more.
        </li>
        <li>
          <strong>Sign-in</strong> — the password field accepts pasting and password managers; no
          puzzle is ever asked.
        </li>
        <li>
          <strong>Checked automatically</strong> — every page, in every mode and theme, is checked
          with the axe-core accessibility engine, and keyboard use is checked in a real browser, by
          the end-to-end tests on every change.
        </li>
      </ul>

      <h3>Known limitations</h3>
      <ul>
        <li>
          Sparklines are pictures of the last minutes of a metric; the figures beside them, which
          screen readers read, give the current values but not the trend.
        </li>
        <li>On narrow screens Widgets are not dragged or resized; their order is kept.</li>
      </ul>

      <h3>Feedback</h3>
      <p>
        If something is hard to use, please{' '}
        <External href={`${REPO_URL}/issues`}>open an issue on GitHub</External> saying what you
        were trying to do, and with which browser and assistive technology.
      </p>
    </div>
  );
}
