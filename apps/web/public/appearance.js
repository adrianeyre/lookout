/* global document, localStorage */
// Applies the saved appearance Settings before the first paint, so there is no flash of the
// wrong colours. A file, not inline, so the Content Security Policy needs no exception.
// Kept in step with src/appearance.ts.
(function () {
  try {
    var root = document.documentElement;
    var mode = localStorage.getItem('lookout.mode');
    var theme = localStorage.getItem('lookout.theme');
    if (mode === 'light' || mode === 'dark') root.setAttribute('data-mode', mode);
    if (/^(ocean|violet|rose|forest|slate)$/.test(theme || '')) root.setAttribute('data-theme', theme);
  } catch {
    // No storage: the defaults (System, Teal) apply.
  }
})();
