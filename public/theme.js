const STORAGE_KEY = '3bot-theme';
const LIGHT_THEME_COLOR = '#f3f6f4';
const DARK_THEME_COLOR = '#07090e';

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyTheme(theme) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', next === 'light' ? LIGHT_THEME_COLOR : DARK_THEME_COLOR);
  const button = document.querySelector('#themeToggle');
  if (button) {
    button.setAttribute('aria-label', next === 'light' ? 'التبديل إلى الوضع الداكن' : 'التبديل إلى الوضع الفاتح');
    button.setAttribute('aria-pressed', next === 'light' ? 'true' : 'false');
  }
}

function initThemeToggle() {
  applyTheme(currentTheme());
  const button = document.querySelector('#themeToggle');
  if (!button) return;
  button.addEventListener('click', () => {
    const next = currentTheme() === 'light' ? 'dark' : 'light';
    try { localStorage.setItem(STORAGE_KEY, next); } catch {}
    applyTheme(next);
  });
}

initThemeToggle();
