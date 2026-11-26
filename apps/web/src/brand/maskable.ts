/** Brand colours. Kept in step with the SVG sources in this folder. */
export const BRAND = {
  /** The telescope's night-sky tile, and the darker header's lighter tile. */
  tile: '#0f172a',
  tileDark: '#1e293b',
  ink: '#0d1b2a',
  paper: '#f0f6fc',
} as const;

/**
 * A maskable icon must keep its content inside the safe zone: a centred circle whose radius
 * is 40% of the icon's width. This takes the square icon, fills the whole canvas with the
 * background colour (no rounded corners) and scales the mark into the safe zone.
 */
export const MASKABLE_SCALE = 0.78;

export function maskableIconSvg(iconSvg: string): string {
  const inner = iconSvg
    .replace(/^[\s\S]*?<svg[^>]*>/, '')
    .replace(/<\/svg>\s*$/, '')
    .replace(/<rect[^>]*\/>/, '');
  const offset = (64 * (1 - MASKABLE_SCALE)) / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">
  <rect width="64" height="64" fill="${BRAND.tile}"/>
  <g transform="translate(${offset} ${offset}) scale(${MASKABLE_SCALE})">${inner}</g>
</svg>
`;
}
