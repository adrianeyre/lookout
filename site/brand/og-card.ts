/**
 * The Project Website's brand colours, and the 1200×630 social card that link previews show
 * (Open Graph and Twitter/X). site/brand.ts renders the card into site/public/og-image.png.
 */
export const BRAND = {
  /** The night sky: the icon's background, theme colour and Windows tile colour. */
  night: '#0f172a',
  /** The star and the telescope's lens. */
  gold: '#fbbf24',
  starlight: '#f8fafc',
  dusk: '#cbd5e1',
} as const;

export const OG_IMAGE_ALT =
  'Lookout, a self-hosted dashboard for your Linux server and its Docker containers: the telescope logo beside the live Host page in dark mode.';

/** A fixed, made-up scatter of stars, so every build draws the same sky. */
function stars(count: number): string {
  let seed = 7;
  const next = () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
  const dots: string[] = [];
  for (let i = 0; i < count; i++) {
    const x = Math.round(next() * 1200);
    const y = Math.round(next() * 630);
    const r = (0.6 + next() * 1.4).toFixed(1);
    const opacity = (0.25 + next() * 0.55).toFixed(2);
    dots.push(`<circle cx="${x}" cy="${y}" r="${r}" fill="#fff" opacity="${opacity}"/>`);
  }
  return dots.join('');
}

export function ogCardHtml(input: {
  icon: string;
  inter: string;
  screenshot: string;
  domain: string;
}): string {
  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<style>
  @font-face { font-family: Inter; font-weight: 100 900; src: url('${input.inter}') format('woff2'); }
  * { box-sizing: border-box; margin: 0; }
  body {
    width: 1200px; height: 630px; overflow: hidden; position: relative;
    font-family: Inter, sans-serif; color: ${BRAND.starlight};
    background:
      radial-gradient(900px 500px at 85% 0%, #1e3a5f 0%, transparent 60%),
      radial-gradient(700px 400px at 0% 100%, #172554 0%, transparent 65%),
      ${BRAND.night};
  }
  .sky { position: absolute; inset: 0; }
  .copy { position: absolute; left: 72px; top: 72px; width: 560px; }
  .brand { display: flex; align-items: center; gap: 20px; margin-bottom: 44px; }
  .brand svg { width: 84px; height: 84px; border-radius: 18px; box-shadow: 0 0 0 1px rgb(255 255 255 / 0.12); }
  .brand span { font-size: 52px; font-weight: 750; letter-spacing: -0.03em; }
  h1 { font-size: 48px; line-height: 1.08; font-weight: 750; letter-spacing: -0.035em; }
  h1 em { white-space: nowrap; font-style: normal; color: ${BRAND.gold}; }
  p { margin-top: 24px; font-size: 25px; line-height: 1.4; color: ${BRAND.dusk}; }
  .url { position: absolute; left: 72px; bottom: 60px; font-size: 22px; font-weight: 600; color: ${BRAND.gold}; letter-spacing: 0.01em; }
  .shot {
    position: absolute; left: 676px; top: 110px; width: 760px;
    border-radius: 16px; overflow: hidden;
    box-shadow: 0 0 0 1px rgb(255 255 255 / 0.14), 0 40px 80px -20px rgb(0 0 0 / 0.75);
  }
  .shot img { display: block; width: 100%; }
</style>
</head>
<body>
  <svg class="sky" viewBox="0 0 1200 630" aria-hidden="true">${stars(90)}</svg>
  <div class="shot"><img src="${input.screenshot}" alt=""></div>
  <div class="copy">
    <div class="brand">${input.icon}<span>Lookout</span></div>
    <h1>Your server’s health and its containers <em>at a glance</em></h1>
    <p>Free, open-source, self-hosted dashboard for one Linux server and Docker.</p>
  </div>
  <div class="url">${input.domain}</div>
</body>
</html>
`;
}
