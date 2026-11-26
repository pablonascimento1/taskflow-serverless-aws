// Camada de APRESENTAÇÃO
//  - Autenticação: conversa direto com o Amazon Cognito (cadastro/login -> token)
//  - Dados/regras: tudo via API REST no API Gateway, enviando o token no cabeçalho Authorization
const CFG = window.TASKFLOW_CONFIG;
const API_URL = CFG.apiUrl.replace(/\/$/, '');
const COGNITO_URL = `https://cognito-idp.${CFG.region}.amazonaws.com/`;

const STATUS_LABEL = { pendente: 'Pendente', em_andamento: 'Em andamento', concluida: 'Concluída' };
const $ = (sel) => document.querySelector(sel);

let token = localStorage.getItem('idToken');
let me = null;

// ---------- utilidades ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 3000);
}

function logCall(method, path, status) {
  const li = document.createElement('li');
  const ok = typeof status === 'number' && status < 400;
  li.innerHTML = `<span class="st ${ok ? 'ok' : 'bad'}">${status}</span><span>${escapeHtml(method)} ${escapeHtml(path)}</span>`;
  const list = $('#api-log');
  list.prepend(li);
  while (list.children.length > 8) list.lastChild.remove();
}

// ---------- AUTENTICAÇÃO: Amazon Cognito ----------
const COGNITO_ERRORS = {
  UsernameExistsException: 'E-mail já cadastrado',
  NotAuthorizedException: 'E-mail ou senha incorretos',
  UserNotFoundException: 'E-mail ou senha incorretos',
  InvalidPasswordException: 'Senha fraca: use ao menos 8 caracteres, com letras minúsculas e números',
  InvalidParameterException: 'Dados inválidos — confira e-mail e senha',
  TooManyRequestsException: 'Muitas tentativas, aguarde um pouco',
};

async function cognito(action, payload) {
  let res;
  try {
    res = await fetch(COGNITO_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-amz-json-1.1',
        'X-Amz-Target': `AWSCognitoIdentityProviderService.${action}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    logCall('COGNITO', action, 'ERR');
    throw new Error('Não foi possível contatar o Cognito');
  }
  logCall('COGNITO', action, res.status);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const type = String(data.__type || '').split('#').pop();
    throw new Error(COGNITO_ERRORS[type] || data.message || 'Falha na autenticação');
  }
  return data;
}

async function login(email, password) {
  const data = await cognito('InitiateAuth', {
    AuthFlow: 'USER_PASSWORD_AUTH',
    ClientId: CFG.userPoolClientId,
    AuthParameters: { USERNAME: email, PASSWORD: password },
  });
  token = data.AuthenticationResult.IdToken; // JWT assinado pelo Cognito
  localStorage.setItem('idToken', token);
  me = await api('/users/me');
  showApp();
}

async function register(name, email, password) {
  await cognito('SignUp', {
    ClientId: CFG.userPoolClientId,
    Username: email,
    Password: password,
    UserAttributes: [{ Name: 'name', Value: name }, { Name: 'email', Value: email }],
  });
  await login(email, password);
}

function logout() {
  token = null;
  me = null;
  localStorage.removeItem('idToken');
  showAuth();
}

// ---------- NEGÓCIOS: toda chamada à API passa por aqui ----------
async function api(path, { method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = token;

  let res;
  try {
    res = await fetch(API_URL + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    logCall(method, path, 'ERR');
    throw new Error('Não foi possível contatar a API');
  }
  logCall(method, path, res.status);

  const data = res.status === 204 ? null : await res.json().catch(() => null);
  if (res.status === 401 && token) {
    logout();
    throw new Error('Sessão expirada, entre novamente');
  }
  if (!res.ok) throw new Error(data?.error || data?.message || `Erro ${res.status}`);
  return data;
}

// ---------- telas ----------
function showAuth() {
  $('#session').classList.add('hidden');
  $('#app-view').classList.add('hidden');
  $('#auth-view').classList.remove('hidden');
}

async function showApp() {
  $('#auth-view').classList.add('hidden');
  $('#app-view').classList.remove('hidden');
  $('#session').classList.remove('hidden');
  $('#who').textContent = me.name;
  const badge = $('#role-badge');
  badge.textContent = me.role;
  badge.className = `badge ${me.role === 'admin' ? 'admin' : ''}`;

  const isAdmin = me.role === 'admin';
  $('#admin-panel').classList.toggle('hidden', !isAdmin);
  $('#tasks-title').textContent = isAdmin ? 'Todas as tarefas' : 'Minhas tarefas';

  await loadTasks();
  if (isAdmin) await loadUsers();
}

// ---------- tarefas ----------
async function loadTasks() {
  const status = $('#status-filter').value;
  try {
    renderTasks(await api(`/tasks${status ? `?status=${status}` : ''}`));
  } catch (e) {
    toast(e.message);
  }
}

function renderTasks(tasks) {
  const isAdmin = me.role === 'admin';
  $('#task-empty').classList.toggle('hidden', tasks.length > 0);
  $('#task-list').innerHTML = tasks.map((t) => `
    <li class="task ${t.status}" data-id="${escapeHtml(t.id)}">
      <div>
        <div class="task-title">${escapeHtml(t.title)}</div>
        <div class="task-meta">
          ${t.description ? escapeHtml(t.description) + ' · ' : ''}
          #${escapeHtml(t.id.slice(0, 8))}${isAdmin ? ` · de ${escapeHtml(t.ownerName)}` : ''}
        </div>
      </div>
      <div class="task-actions">
        <select data-action="status" aria-label="Status">
          ${Object.entries(STATUS_LABEL).map(([v, l]) => `<option value="${v}" ${v === t.status ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="danger" data-action="delete">Excluir</button>
      </div>
    </li>`).join('');
}

// ---------- usuários (admin) ----------
async function loadUsers() {
  try {
    const users = await api('/users');
    $('#user-rows').innerHTML = users.map((u) => {
      const self = u.id === me.id;
      return `
      <tr data-id="${escapeHtml(u.id)}">
        <td>${escapeHtml(u.id.slice(0, 8))}</td>
        <td>${escapeHtml(u.name)}${self ? ' <span class="muted">(você)</span>' : ''}</td>
        <td>${escapeHtml(u.email)}</td>
        <td>${u.taskCount}</td>
        <td>
          <select data-action="role" ${self ? 'disabled' : ''} aria-label="Papel">
            <option value="user" ${u.role === 'user' ? 'selected' : ''}>user</option>
            <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>admin</option>
          </select>
        </td>
        <td>${self ? '' : '<button class="danger" data-action="delete-user">Remover</button>'}</td>
      </tr>`;
    }).join('');
  } catch (e) {
    toast(e.message);
  }
}

// ---------- eventos ----------
document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
  $('#login-form').classList.toggle('hidden', tab.dataset.tab !== 'login');
  $('#register-form').classList.toggle('hidden', tab.dataset.tab !== 'register');
  $('#auth-error').textContent = '';
}));

$('#login-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { email, password } = Object.fromEntries(new FormData(ev.target));
  $('#auth-error').textContent = '';
  try {
    await login(email.trim(), password);
    ev.target.reset();
  } catch (e) {
    $('#auth-error').textContent = e.message;
  }
});

$('#register-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const { name, email, password } = Object.fromEntries(new FormData(ev.target));
  $('#auth-error').textContent = '';
  try {
    await register(name.trim(), email.trim(), password);
    ev.target.reset();
    toast('Conta criada!');
  } catch (e) {
    $('#auth-error').textContent = e.message;
  }
});

$('#logout').addEventListener('click', logout);
$('#status-filter').addEventListener('change', loadTasks);

$('#task-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const body = Object.fromEntries(new FormData(ev.target));
  try {
    await api('/tasks', { method: 'POST', body });
    ev.target.reset();
    await loadTasks();
    if (me.role === 'admin') loadUsers();
  } catch (e) {
    toast(e.message);
  }
});

$('#task-list').addEventListener('change', async (ev) => {
  if (ev.target.dataset.action !== 'status') return;
  const id = ev.target.closest('.task').dataset.id;
  try {
    await api(`/tasks/${id}`, { method: 'PATCH', body: { status: ev.target.value } });
    await loadTasks();
  } catch (e) {
    toast(e.message);
  }
});

$('#task-list').addEventListener('click', async (ev) => {
  if (ev.target.dataset.action !== 'delete') return;
  const id = ev.target.closest('.task').dataset.id;
  if (!confirm('Excluir esta tarefa?')) return;
  try {
    await api(`/tasks/${id}`, { method: 'DELETE' });
    await loadTasks();
    if (me.role === 'admin') loadUsers();
  } catch (e) {
    toast(e.message);
  }
});

$('#user-rows').addEventListener('change', async (ev) => {
  if (ev.target.dataset.action !== 'role') return;
  const id = ev.target.closest('tr').dataset.id;
  try {
    const r = await api(`/users/${id}`, { method: 'PATCH', body: { role: ev.target.value } });
    toast(r.note || 'Papel atualizado');
  } catch (e) {
    toast(e.message);
  }
  loadUsers();
});

$('#user-rows').addEventListener('click', async (ev) => {
  if (ev.target.dataset.action !== 'delete-user') return;
  const id = ev.target.closest('tr').dataset.id;
  if (!confirm('Remover este usuário e todas as tarefas dele?')) return;
  try {
    await api(`/users/${id}`, { method: 'DELETE' });
    await Promise.all([loadUsers(), loadTasks()]);
  } catch (e) {
    toast(e.message);
  }
});

// ---------- inicialização ----------
$('#api-url').textContent = API_URL;
(async () => {
  if (!token) return showAuth();
  try {
    me = await api('/users/me');
    showApp();
  } catch {
    logout();
  }
})();
