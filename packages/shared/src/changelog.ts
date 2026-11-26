/**
 * Turns CHANGELOG.md, which semantic-release writes on every release, into the Changelog
 * modal in the dashboard's footer and the Project Website's, and its "Version" label. It
 * reads only the Markdown that semantic-release writes: headings, bullet lists, links, bold
 * and inline code. Everything is escaped, so the HTML is safe to insert.
 */

const escapeHtml = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');

export interface Changelog {
  /** The newest released version, such as "1.2.0", or null before the first release. */
  version: string | null;
  /** The modal's body. */
  html: string;
}

/** Inline Markdown: [text](https://…), **bold** and `code`. Only http(s) links are kept. */
export function inline(markdown: string): string {
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
  let html = '';
  let last = 0;
  for (const match of markdown.matchAll(pattern)) {
    html += escapeHtml(markdown.slice(last, match.index));
    const [, linkText, href, bold, code] = match;
    if (href !== undefined && linkText !== undefined) {
      html += `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${inline(linkText)}</a>`;
    } else if (bold !== undefined) {
      html += `<strong>${inline(bold)}</strong>`;
    } else if (code !== undefined) {
      html += `<code>${escapeHtml(code)}</code>`;
    }
    last = match.index + match[0].length;
  }
  return html + escapeHtml(markdown.slice(last));
}

/** The newest releases, at most `limit` of them, as HTML. */
export function renderChangelog(markdown: string, releasesUrl: string, limit = 10): Changelog {
  const lines = markdown.split(/\r?\n/);
  const html: string[] = [];
  let version: string | null = null;
  let releases = 0;
  let inList = false;
  const closeList = () => {
    if (inList) html.push('</ul>');
    inList = false;
  };

  for (const line of lines) {
    const release = /^##? (?!#)(.*)$/.exec(line);
    const section = /^### (.*)$/.exec(line);
    const item = /^\s*[*-] (.*)$/.exec(line);
    if (release) {
      const text = release[1]!.trim();
      const found = /\d+\.\d+\.\d+(?:-[\w.]+)?/.exec(text)?.[0];
      // Skip a top-level title such as "# Changelog".
      if (!found) continue;
      if (releases === limit) break;
      closeList();
      releases++;
      version ??= found;
      html.push(`<h3>${inline(text)}</h3>`);
    } else if (releases === 0) {
      continue;
    } else if (section) {
      closeList();
      html.push(`<h4>${inline(section[1]!.trim())}</h4>`);
    } else if (item) {
      if (!inList) html.push('<ul>');
      inList = true;
      html.push(`<li>${inline(item[1]!.trim())}</li>`);
    } else if (line.trim() !== '') {
      closeList();
      html.push(`<p>${inline(line.trim())}</p>`);
    }
  }
  closeList();

  const all = `<p>Every release, with its changes and Images, is on <a href="${escapeHtml(releasesUrl)}" target="_blank" rel="noopener noreferrer">GitHub Releases</a>.</p>`;
  if (releases === 0) {
    return {
      version: null,
      html: `<p>Lookout has not had its first release yet.</p>\n${all}`,
    };
  }
  return { version, html: `${html.join('\n')}\n${all}` };
}
