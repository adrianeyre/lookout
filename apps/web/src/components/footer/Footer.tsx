import { useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AccessibilityStatement,
  Changelog,
  CookiePolicy,
  Credits,
  PrivacyPolicy,
  REPO_URL,
  TermsAndConditions,
} from './content.tsx';
import { ModalDialog } from './ModalDialog.tsx';

interface FooterItem {
  key: string;
  label: string;
  /** The modal's title, when it is not the label. */
  title?: string;
  closeLabel: string;
  body: ReactNode;
}

const VERSION = import.meta.env.VITE_LOOKOUT_VERSION;

const ITEMS: FooterItem[] = [
  {
    key: 'version',
    label: `Version: ${VERSION}`,
    title: 'Changelog',
    closeLabel: 'Close changelog',
    body: <Changelog />,
  },
  { key: 'credits', label: 'Credits', closeLabel: 'Close credits', body: <Credits /> },
  {
    key: 'privacy',
    label: 'Privacy policy',
    closeLabel: 'Close privacy policy',
    body: <PrivacyPolicy />,
  },
  {
    key: 'terms',
    label: 'Terms and conditions',
    closeLabel: 'Close terms and conditions',
    body: <TermsAndConditions />,
  },
  {
    key: 'cookies',
    label: 'Cookie policy',
    closeLabel: 'Close cookie policy',
    body: <CookiePolicy />,
  },
  {
    key: 'accessibility',
    label: 'Accessibility',
    closeLabel: 'Close accessibility statement',
    body: <AccessibilityStatement />,
  },
];

const FOOTER_HEIGHT = '--footer-height';

/**
 * The footer on every page, like the Project Website's: "Website design" opens the source on
 * GitHub in a new tab; every other item, the version first, opens its information in a modal.
 * It is sticky on wide screens, and publishes its height so the page can keep focused content
 * clear of it (WCAG 2.4.11 Focus Not Obscured).
 */
export function Footer() {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const footerRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const footer = footerRef.current;
    if (!footer || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement.style;
    const observer = new ResizeObserver(() => {
      const sticky = getComputedStyle(footer).position === 'sticky';
      root.setProperty(FOOTER_HEIGHT, sticky ? `${footer.offsetHeight}px` : '0px');
    });
    observer.observe(footer);
    return () => {
      observer.disconnect();
      root.removeProperty(FOOTER_HEIGHT);
    };
  }, []);

  return (
    <footer className="footer" ref={footerRef}>
      <nav aria-label="About Lookout">
        <ul className="footer__list">
          <li>
            <a className="footer__link" href={REPO_URL} target="_blank" rel="noopener noreferrer">
              <svg
                className="footer__icon"
                viewBox="0 0 16 16"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M8 0c4.42 0 8 3.58 8 8a8.013 8.013 0 0 1-5.45 7.59c-.4.08-.55-.17-.55-.38 0-.27.01-1.13.01-2.2 0-.75-.25-1.23-.54-1.48 1.78-.2 3.65-.88 3.65-3.95 0-.88-.31-1.59-.82-2.15.08-.2.36-1.02-.08-2.12 0 0-.67-.22-2.2.82-.64-.18-1.32-.27-2-.27-.68 0-1.36.09-2 .27-1.53-1.03-2.2-.82-2.2-.82-.44 1.1-.16 1.92-.08 2.12-.51.56-.82 1.28-.82 2.15 0 3.06 1.86 3.75 3.64 3.95-.23.2-.44.55-.51 1.07-.46.21-1.61.55-2.33-.66-.15-.24-.6-.83-1.23-.82-.67.01-.27.38.01.53.34.19.73.9.82 1.13.16.45.68 1.31 2.69.94 0 .67.01 1.3.01 1.49 0 .21-.15.45-.55.38A7.995 7.995 0 0 1 0 8c0-4.42 3.58-8 8-8Z" />
              </svg>
              Website design
              <span className="visually-hidden">, source on GitHub, opens in a new tab</span>
            </a>
          </li>
          {ITEMS.map((item) => (
            <li key={item.key}>
              <button
                type="button"
                className="footer__link"
                aria-haspopup="dialog"
                data-testid={item.key === 'version' ? 'version' : undefined}
                onClick={() => setOpenKey(item.key)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      {ITEMS.map((item) => (
        <ModalDialog
          key={item.key}
          isOpen={openKey === item.key}
          onClose={() => setOpenKey(null)}
          title={item.title ?? item.label}
          closeLabel={item.closeLabel}
        >
          {item.body}
        </ModalDialog>
      ))}
    </footer>
  );
}
