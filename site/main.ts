/**
 * The page's only script. Everything it does is an enhancement: without it, the footer's
 * modals still open (through `commandfor`, in current browsers), each screenshot is a link to
 * the full-size image, and the commands can be selected and copied by hand.
 *
 * It uses no storage and makes no requests beyond the screenshots themselves.
 */

const modals = [...document.querySelectorAll<HTMLDialogElement>('dialog.modal')];

/** Browsers without Invoker Commands (`commandfor`/`command`) get the same behaviour here. */
if (!('command' in HTMLButtonElement.prototype)) {
  document.addEventListener('click', (event) => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>(
      'button[commandfor]',
    );
    if (!button) return;
    const dialog = document.getElementById(button.getAttribute('commandfor') ?? '');
    if (!(dialog instanceof HTMLDialogElement)) return;
    const command = button.getAttribute('command');
    if (command === 'show-modal' && !dialog.open) dialog.showModal();
    if (command === 'close') dialog.close();
  });
}

for (const dialog of modals) {
  // A click on the backdrop closes it, where `closedby="any"` is not supported yet.
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) dialog.close();
  });
  // Open modals can be linked to, such as /#privacy, and the back button closes them.
  let pushed = false;
  dialog.addEventListener('toggle', (event) => {
    const opening = event.newState === 'open';
    const hash = `#${dialog.id}`;
    if (opening && location.hash !== hash) {
      history.pushState(null, '', hash);
      pushed = true;
    } else if (!opening && location.hash === hash) {
      // Back, to the entry before the modal; or, if the page was opened at the modal, drop
      // the hash without leaving the site.
      if (pushed) history.back();
      else history.replaceState(null, '', location.pathname + location.search);
    }
    if (!opening) pushed = false;
  });
}

function openFromHash(): void {
  const id = decodeURIComponent(location.hash.slice(1));
  for (const dialog of modals) {
    if (dialog.id === id && !dialog.open) dialog.showModal();
    if (dialog.id !== id && dialog.open) dialog.close();
  }
}
window.addEventListener('popstate', openFromHash);
openFromHash();

/**
 * Publishes the sticky footer's height, so scroll-padding keeps focused content clear of it
 * (WCAG 2.4.11 Focus Not Obscured). It is 0 wherever the footer is not sticky.
 */
const footer = document.querySelector<HTMLElement>('.footer');
if (footer && typeof ResizeObserver === 'function') {
  new ResizeObserver(() => {
    const sticky = getComputedStyle(footer).position === 'sticky';
    document.documentElement.style.setProperty(
      '--footer-height',
      sticky ? `${footer.offsetHeight}px` : '0px',
    );
  }).observe(footer);
}

/** A Copy button on every command, which says when it has copied. */
if (window.isSecureContext && 'clipboard' in navigator) {
  for (const pre of document.querySelectorAll<HTMLPreElement>('main pre')) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'copy';
    const label = document.createElement('span');
    label.textContent = 'Copy';
    button.innerHTML =
      '<svg class="icon" aria-hidden="true" focusable="false"><use href="#i-copy"/></svg>';
    button.append(label);
    const status = document.createElement('span');
    status.className = 'visually-hidden';
    status.setAttribute('role', 'status');
    let timer: number | undefined;
    const copy = async () => {
      try {
        await navigator.clipboard.writeText(pre.innerText.trim());
        label.textContent = 'Copied';
        status.textContent = 'Copied to the clipboard';
      } catch {
        label.textContent = 'Select and copy';
        status.textContent = 'Could not copy; select the text and copy it instead';
      }
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        label.textContent = 'Copy';
        status.textContent = '';
      }, 2000);
    };
    button.addEventListener('click', () => void copy());
    const wrapper = document.createElement('div');
    wrapper.className = 'code';
    pre.replaceWith(wrapper);
    wrapper.append(pre, button, status);
  }
}

/** Screenshots open in a lightbox, in the same theme as the page. */
const lightbox = document.querySelector<HTMLDialogElement>('dialog.lightbox');
const caption = lightbox?.querySelector<HTMLElement>('.lightbox__caption');

if (lightbox && caption && typeof lightbox.showModal === 'function') {
  const image = document.createElement('img');
  image.className = 'lightbox__image';
  lightbox.append(image);
  const dark = window.matchMedia('(prefers-color-scheme: dark)');
  let opener: HTMLElement | null = null;

  for (const link of document.querySelectorAll<HTMLAnchorElement>('a.shot')) {
    link.addEventListener('click', (event) => {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
        return;
      }
      event.preventDefault();
      const thumbnail = link.querySelector('img');
      image.src = dark.matches && link.dataset.dark ? link.dataset.dark : link.href;
      image.alt = thumbnail?.alt ?? '';
      image.width = thumbnail?.width ?? 0;
      image.height = thumbnail?.height ?? 0;
      caption.textContent = link.querySelector('.shot__caption')?.textContent ?? '';
      opener = link;
      lightbox.showModal();
    });
  }

  lightbox.addEventListener('click', (event) => {
    if (event.target === lightbox) lightbox.close();
  });
  lightbox.addEventListener('close', () => {
    image.removeAttribute('src');
    opener?.focus();
  });
}
