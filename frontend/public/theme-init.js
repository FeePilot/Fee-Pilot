(function () {
  document.documentElement.classList.remove('no-js');
  try {
    var saved = localStorage.getItem('feepilot.theme');
    var theme = saved === 'light' || saved === 'dark'
      ? saved
      : window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) { /* storage blocked: keep the default */ }
})();
