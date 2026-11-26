import { useEffect, useId, useRef, type ReactNode } from 'react';

/**
 * A native modal <dialog>: the rest of the page is inert while it is open, focus moves into it
 * on opening and back to the control that opened it on closing, and Esc, the close button, the
 * footer's Close button or a click on the backdrop closes it.
 */
export function ModalDialog({
  isOpen,
  onClose,
  title,
  closeLabel,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  closeLabel: string;
  children: ReactNode;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (isOpen && !dialog.open) {
      openerRef.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      closeRef.current?.focus();
    } else if (!isOpen && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
      openerRef.current?.focus();
      openerRef.current = null;
    }
  }, [isOpen]);

  return (
    <dialog
      ref={dialogRef}
      className="modal"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {isOpen && (
        <>
          <div className="modal__header">
            <h2 id={titleId}>{title}</h2>
            <button
              ref={closeRef}
              type="button"
              className="icon-button"
              aria-label={closeLabel}
              onClick={onClose}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          {/* Focusable, so the body can be scrolled with the keyboard (WCAG 2.1.1). */}
          <div className="modal__body" role="region" aria-labelledby={titleId} tabIndex={0}>
            {children}
          </div>
          <div className="modal__footer">
            <button type="button" className="button" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      )}
    </dialog>
  );
}
