import type { MouseEvent, ReactNode } from 'react';
import { navigate } from '../router.ts';

/** A link that navigates inside the SPA, leaving modified clicks to the browser. */
export function Link({
  href,
  children,
  className,
  current,
  testId,
}: {
  href: string;
  children: ReactNode;
  className?: string;
  current?: boolean;
  testId?: string;
}) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    navigate(href);
  };
  return (
    <a
      href={href}
      onClick={onClick}
      className={className}
      aria-current={current ? 'page' : undefined}
      data-testid={testId}
    >
      {children}
    </a>
  );
}
