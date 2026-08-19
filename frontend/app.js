// app.js — funções partilhadas entre index.html, curso.html e login.html.
// HTML/CSS/JS puro, sem framework, sem build step.

const API_BASE = 'http://localhost:5000';

/**
 * Faz fetch à API, juntando automaticamente o header Authorization com o
 * token do localStorage (se existir). Lança um Error com uma mensagem
 * legível (nunca um objecto JSON cru) quando a resposta não é OK.
 */
async function apiFetch(path, opts = {}) {
  const token = localStorage.getItem('token');
  const headers = Object.assign({}, opts.headers);

  if (opts.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  let res;
  try {
    res = await fetch(`${API_BASE}${path}`, Object.assign({}, opts, { headers }));
  } catch (err) {
    throw new Error('Não foi possível ligar ao servidor. Verifica se o backend está a correr.');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }

  if (!res.ok) {
    const message = (data && data.error) || `Erro ${res.status}`;
    throw new Error(message);
  }

  return data;
}

/** Formata um valor em Kwanza: 50000 -> "50 000 Kz" */
function formatKz(n) {
  const num = Number(n) || 0;
  return `${num.toLocaleString('pt-PT').replace(/,/g, ' ')} Kz`;
}

/** Remove sessão do localStorage e volta para a página de login. */
function logout() {
  localStorage.removeItem('token');
  localStorage.removeItem('user');
  window.location.href = 'login.html';
}

/** Devolve o utilizador guardado no localStorage, ou null. */
function getStoredUser() {
  const raw = localStorage.getItem('user');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Preenche o cabeçalho partilhado (elemento com id="header-actions"):
 * mostra nome do utilizador + botão sair se houver sessão, caso contrário
 * mostra um botão "Entrar".
 */
function renderHeader() {
  const el = document.getElementById('header-actions');
  if (!el) return;

  const user = getStoredUser();
  const token = localStorage.getItem('token');

  if (token && user) {
    el.innerHTML = '';
    const span = document.createElement('span');
    span.className = 'header-user';
    span.textContent = `Olá, ${user.name}`;

    const btn = document.createElement('button');
    btn.className = 'btn btn-outline';
    btn.textContent = 'Sair';
    btn.addEventListener('click', logout);

    el.appendChild(span);
    el.appendChild(btn);
  } else {
    el.innerHTML = '';
    const link = document.createElement('a');
    link.className = 'btn btn-outline';
    link.href = 'login.html';
    link.textContent = 'Entrar';
    el.appendChild(link);
  }
}

/** Mostra uma mensagem de erro legível dentro do elemento indicado. */
function showError(containerEl, err) {
  if (!containerEl) return;
  containerEl.textContent = err instanceof Error ? err.message : String(err);
  containerEl.classList.remove('hidden');
}

function clearError(containerEl) {
  if (!containerEl) return;
  containerEl.textContent = '';
  containerEl.classList.add('hidden');
}
