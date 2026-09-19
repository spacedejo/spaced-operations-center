const root = document.documentElement;
const themeToggle = document.querySelector('.theme-toggle');
const menuToggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('.site-header__nav');

function setTheme(theme) {
  root.dataset.theme = theme;
  localStorage.setItem('spaced-theme', theme);
  themeToggle.setAttribute('aria-pressed', String(theme === 'light'));
  themeToggle.setAttribute('aria-label', `Alternar para tema ${theme === 'light' ? 'escuro' : 'claro'}`);
}

setTheme(root.dataset.theme || 'dark');
themeToggle.addEventListener('click', () => setTheme(root.dataset.theme === 'dark' ? 'light' : 'dark'));

menuToggle.addEventListener('click', () => {
  const isOpen = navigation.classList.toggle('is-open');
  menuToggle.setAttribute('aria-expanded', String(isOpen));
  menuToggle.setAttribute('aria-label', isOpen ? 'Fechar menu' : 'Abrir menu');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && navigation.classList.contains('is-open')) {
    navigation.classList.remove('is-open');
    menuToggle.setAttribute('aria-expanded', 'false');
    menuToggle.setAttribute('aria-label', 'Abrir menu');
    menuToggle.focus();
  }
});
