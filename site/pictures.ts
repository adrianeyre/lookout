/**
 * Responsive screenshots. index.html names a screenshot once, as
 *
 *   <img data-shot="host-desktop" alt="…" sizes="…" loading="lazy" />
 *
 * and the build expands it into a <picture> that serves AVIF, then WebP, then PNG, in the
 * reader's light or dark theme, at the width the layout needs. data-theme="dark" always shows
 * the dark screenshot, for a section that is always dark. The images come from
 * docs/images/<page>-<theme>-<form>.png; the build writes the AVIF and WebP copies beside them.
 */
export const FORMS = {
  desktop: { width: 1280, height: 860, widths: [640, 1280] },
  phone: { width: 390, height: 844, widths: [390] },
} as const;
export type Form = keyof typeof FORMS;

/** The file name, without extension, of one size of one screenshot. */
export function variant(base: string, width: number, form: Form): string {
  return width === FORMS[form].width ? base : `${base}-${width}`;
}

function srcset(base: string, form: Form, extension: string): string {
  return FORMS[form].widths
    .map((width) => `/images/${variant(base, width, form)}.${extension} ${width}w`)
    .join(', ');
}

/** The <picture> for one screenshot, such as "host-desktop". */
export function picture(shot: string, attributes: string): string {
  const match = /^(.+)-(desktop|phone)$/.exec(shot);
  if (!match) throw new Error(`data-shot="${shot}" must end in -desktop or -phone`);
  const [, page, form] = match as unknown as [string, string, Form];
  const { width, height } = FORMS[form];
  const sizes = /\ssizes="([^"]*)"/.exec(attributes)?.[1] ?? `${width}px`;
  const fixed = /\sdata-theme="(light|dark)"/.exec(attributes)?.[1] as 'light' | 'dark' | undefined;
  const rest = attributes
    .replace(/\ssizes="[^"]*"/, '')
    .replace(/\sdata-theme="[^"]*"/, '')
    .trim();
  const theme = (name: 'light' | 'dark') => `${page}-${fixed ?? name}-${form}`;
  const sources = (name: 'light' | 'dark') => {
    const media = name === 'dark' ? ' media="(prefers-color-scheme: dark)"' : '';
    return [
      `<source type="image/avif"${media} srcset="${srcset(theme(name), form, 'avif')}" sizes="${sizes}" />`,
      `<source type="image/webp"${media} srcset="${srcset(theme(name), form, 'webp')}" sizes="${sizes}" />`,
      ...(name === 'dark' ? [`<source${media} srcset="/images/${theme(name)}.png" />`] : []),
    ];
  };
  if (fixed) {
    return [
      '<picture>',
      ...sources('light'),
      `<img src="/images/${theme('light')}.png" width="${width}" height="${height}" decoding="async" ${rest} />`,
      '</picture>',
    ].join('');
  }
  return [
    '<picture>',
    ...sources('dark'),
    ...sources('light'),
    `<img src="/images/${theme('light')}.png" width="${width}" height="${height}" decoding="async" ${rest} />`,
    '</picture>',
  ].join('');
}

/** Expands every <img data-shot="…"> in the page. */
export function expandPictures(html: string): string {
  return html.replace(/<img\s+data-shot="([^"]+)"([^>]*?)\/?>/g, (_, shot: string, attrs: string) =>
    picture(shot, attrs),
  );
}
