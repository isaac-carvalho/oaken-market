// admin.js — lógica partilhada das 3 páginas do painel de produtor
// (frontend/admin/*.html). Depende de app.js (apiFetch, formatKz,
// initTheme, toggleTheme, logout, getStoredUser) já carregado antes
// deste ficheiro via <script src="../app.js">. Não duplica nada disso.

const ADMIN_NAV_ITEMS = [
  { key: 'dashboard', href: 'index.html', icon: '📊', label: 'Dashboard', soon: false },
  { key: 'produtos', href: 'produtos.html', icon: '📦', label: 'Produtos', soon: false },
  { key: 'vendas', href: 'vendas.html', icon: '💳', label: 'Vendas', soon: false },
  { key: 'afiliados', href: 'afiliados.html', icon: '🤝', label: 'Afiliados', soon: false },
  { key: 'financeiro', href: 'financeiro.html', icon: '💰', label: 'Financeiro', soon: false },
  { key: 'integracoes', href: 'integracoes.html', icon: '🔌', label: 'Integrações', soon: false },
  { key: 'ranking', href: null, icon: '🏆', label: 'Ranking', soon: true },
];

/**
 * Verifica se há sessão activa e se o utilizador é ADMIN.
 * - Sem token: reencaminha para ../login.html?next=admin/<pagina>.
 * - Com token mas role !== 'ADMIN': devolve null (o chamador mostra o
 *   bloqueio, o painel nunca chega a renderizar).
 * - ADMIN: devolve o objecto user.
 */
function requireAdminAccess() {
  const token = localStorage.getItem('token');
  const user = getStoredUser();

  if (!token || !user) {
    const here = 'admin/' + window.location.pathname.split('/').pop();
    window.location.href = `../login.html?next=${encodeURIComponent(here)}`;
    return null;
  }

  if (user.role !== 'ADMIN') {
    return null;
  }

  return user;
}

/** Mostra o ecrã de acesso negado (utilizador autenticado mas não ADMIN). */
function showAdminBlocked() {
  const blocked = document.getElementById('admin-blocked');
  const app = document.getElementById('admin-app');
  if (app) app.classList.add('hidden');
  if (blocked) blocked.classList.remove('hidden');
}

/** Constrói a sidebar fixa nas 3 páginas, marcando o item activo. */
function renderAdminSidebar(activeKey) {
  const nav = document.getElementById('admin-nav');
  if (!nav) return;

  nav.innerHTML = ADMIN_NAV_ITEMS.map((item) => {
    if (item.soon) {
      return `
        <span class="admin-nav-item admin-nav-item-disabled" title="${item.label} — ainda não disponível">
          <span class="admin-nav-icon">${item.icon}</span>
          <span class="admin-nav-label">${item.label}</span>
          <span class="admin-nav-soon">Em breve</span>
        </span>
      `;
    }
    const active = item.key === activeKey ? ' admin-nav-item-active' : '';
    return `
      <a class="admin-nav-item${active}" href="${item.href}" title="${item.label}">
        <span class="admin-nav-icon">${item.icon}</span>
        <span class="admin-nav-label">${item.label}</span>
      </a>
    `;
  }).join('');
}

/** Preenche o cabeçalho da sidebar com nome/email do admin autenticado. */
function renderAdminUser(user) {
  const el = document.getElementById('admin-user');
  if (!el) return;
  el.innerHTML = `
    <div class="admin-user-name">${user.name}</div>
    <div class="admin-user-email">${user.email}</div>
  `;
}

/**
 * Ponto de entrada comum às 3 páginas: valida acesso ADMIN, monta sidebar
 * e cabeçalho. Devolve o user se o painel pode renderizar, ou null se
 * já mostrou o bloqueio (o chamador deve parar aí, sem pedir dados à API).
 */
function initAdminPage(activeKey) {
  initTheme();
  const user = requireAdminAccess();
  if (!user) {
    showAdminBlocked();
    return null;
  }

  const app = document.getElementById('admin-app');
  if (app) app.classList.remove('hidden');

  renderAdminSidebar(activeKey);
  renderAdminUser(user);

  const logoutBtn = document.getElementById('admin-logout-btn');
  if (logoutBtn) logoutBtn.addEventListener('click', logout);

  return user;
}
