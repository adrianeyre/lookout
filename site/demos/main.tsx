/**
 * Mounts the hero demo (PRD WEB-5) into its `data-demo` slot in index.html. Without
 * JavaScript the slot keeps the static screenshot it holds, so the page reads in full; with
 * it, the demo replaces the screenshot. The demo sets no cookies or storage and requests
 * nothing beyond the page's own logo.
 */
import { StrictMode, type ComponentType } from 'react';
import { createRoot } from 'react-dom/client';
import { HeroDemo } from './hero.tsx';
import { useSystemTheme } from './theme.ts';
import './look.css';

type Demo = ComponentType<{ theme: 'light' | 'dark' }>;

const DEMOS: Partial<Record<string, Demo>> = { hero: HeroDemo };

function Themed({ Demo }: { Demo: Demo }) {
  return <Demo theme={useSystemTheme()} />;
}

for (const slot of document.querySelectorAll<HTMLElement>('[data-demo]')) {
  const Demo = DEMOS[slot.dataset.demo ?? ''];
  if (!Demo) throw new Error(`index.html names an unknown demo "${slot.dataset.demo ?? ''}"`);
  slot.dataset.live = '';
  createRoot(slot).render(
    <StrictMode>
      <Themed Demo={Demo} />
    </StrictMode>,
  );
}
