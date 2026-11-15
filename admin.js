const main = document.querySelector('#adminMain');
const logoutButton = document.querySelector('#logoutButton');
const modal = document.querySelector('#confirmModal');
const confirmText = document.querySelector('#confirmText');
const confirmDelete = document.querySelector('#confirmDelete');
const cancelDelete = document.querySelector('#cancelDelete');

const TYPE_LABELS = { text: 'منشور نصي', image: 'صورة', video: 'فيديو', poll: 'استطلاع رأي' };
let pendingDeleteId = null;

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function showToast(message, type = 'success') {
  const stack = document.querySelector('#toastStack');
  if (!stack) return;
  const titles = { success: 'تم بنجاح', error: 'تعذر إكمال الإجراء', info: 'تنبيه' };
  const icons = { success: '✓', error: '!', info: 'i' };
  const toast = make('section', `toast toast--${type}`);
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  const icon = make('span', 'toast-icon', icons[type] || icons.info);
  icon.setAttribute('aria-hidden', 'true');
  const copy = make('div', 'toast-copy');
  copy.append(make('strong', 'toast-title', titles[type] || titles.info));
  copy.append(make('p', 'toast-message', message));
  const close = make('button', 'toast-close', '×');
  close.type = 'button';
  close.setAttribute('aria-label', 'إغلاق التنبيه');
  toast.append(icon, copy, close);
  stack.append(toast);
  while (stack.children.length > 3) stack.firstElementChild.remove();
  let timer;
  const dismiss = () => {
    window.clearTimeout(timer);
    toast.dataset.leaving = 'true';
    toast.addEventListener('animationend', () => toast.remove(), { once: true });
    window.setTimeout(() => toast.remove(), 250);
  };
  close.addEventListener('click', dismiss);
  timer = window.setTimeout(dismiss, 5500);
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    headers: { Accept: 'application/json', ...(options.body && !(options.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'تعذر إكمال الطلب.');
    error.status = response.status;
    throw error;
  }
  return data;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  return new Intl.DateTimeFormat('ar', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function previewText(content) {
  const text = String(content || '').trim();
  if (!text) return 'بدون نص';
  return text.length > 160 ? `${text.slice(0, 157)}…` : text;
}

function updatePostCount() {
  const count = document.querySelector('#postCount');
  if (!count) return;
  const cards = main.querySelectorAll('.admin-post');
  const total = cards.length;
  if (!total) {
    count.textContent = 'لا توجد مشاركات';
    return;
  }
  const hiddenTotal = main.querySelectorAll('.admin-post.is-hidden').length;
  count.textContent = hiddenTotal
    ? `${total} مشاركة (${hiddenTotal} مخفية)`
    : `${total} مشاركة`;
}

function setWritePostVisible(visible) {
  const writePostButton = document.querySelector('#writePostButton');
  if (writePostButton) writePostButton.hidden = !visible;
}

function renderDisabled() {
  logoutButton.hidden = true;
  setWritePostVisible(false);
  const card = make('section', 'disabled-card');
  card.append(make('p', 'eyebrow', 'غير مفعّلة'));
  card.append(make('h1', '', 'لوحة الإدارة غير مفعّلة'));
  card.append(make('p', '', 'لتفعيلها، أضف المتغيرين ADMIN_PASSWORD وSESSION_SECRET إلى إعدادات البيئة ثم أعد تشغيل الخادم.'));
  main.replaceChildren(card);
}

function renderLogin(message) {
  logoutButton.hidden = true;
  setWritePostVisible(false);
  const card = make('form', 'login-card composer-card');
  card.id = 'loginForm';
  const chrome = make('div', 'composer-chrome');
  chrome.setAttribute('aria-hidden', 'true');
  chrome.append(make('span'), make('span'), make('span'));
  card.append(chrome);
  card.append(make('p', 'eyebrow', 'دخول محمي'));
  card.append(make('h1', '', 'تسجيل الدخول إلى لوحة الإدارة'));
  card.append(make('p', 'login-lead', 'أدخل كلمة مرور الإدارة لمتابعة المشاركات وإدارتها.'));
  const label = make('label', 'field-label', 'كلمة المرور');
  label.setAttribute('for', 'adminPassword');
  const input = document.createElement('input');
  input.type = 'password';
  input.id = 'adminPassword';
  input.name = 'password';
  input.required = true;
  input.autocomplete = 'current-password';
  const button = make('button', 'button button-primary', 'دخول');
  button.type = 'submit';
  button.id = 'loginSubmit';
  const status = make('p', 'form-message');
  status.id = 'loginMessage';
  status.setAttribute('role', 'status');
  if (message) {
    status.textContent = message;
    status.className = 'form-message error';
  }
  card.append(label, input, button, status);
  card.addEventListener('submit', onLogin);
  main.replaceChildren(card);
  input.focus();
}

async function onLogin(event) {
  event.preventDefault();
  const input = document.querySelector('#adminPassword');
  const button = document.querySelector('#loginSubmit');
  const status = document.querySelector('#loginMessage');
  button.disabled = true;
  button.textContent = 'جارٍ التحقق...';
  status.textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: input.value }) });
    showToast('تم تسجيل الدخول بنجاح.', 'success');
    await showDashboard();
  } catch (error) {
    status.textContent = error.message;
    status.className = 'form-message error';
    showToast(error.message, 'error');
  } finally {
    button.disabled = false;
    button.textContent = 'دخول';
  }
}

function mediaPreview(post) {
  const box = make('div', 'admin-media');
  if (post.type === 'image' && post.mediaUrl) {
    const image = document.createElement('img');
    image.src = post.mediaUrl;
    image.alt = post.content ? `صورة: ${previewText(post.content)}` : 'صورة منشورة';
    image.loading = 'lazy';
    image.addEventListener('error', () => { box.replaceChildren(); box.textContent = TYPE_LABELS.image; });
    box.append(image);
    return box;
  }
  if (post.type === 'video' && post.mediaUrl) {
    const video = document.createElement('video');
    video.src = post.mediaUrl;
    video.preload = 'metadata';
    video.muted = true;
    video.setAttribute('aria-label', 'مقطع فيديو');
    video.addEventListener('error', () => { box.replaceChildren(); box.textContent = TYPE_LABELS.video; });
    box.append(video);
    return box;
  }
  box.textContent = TYPE_LABELS[post.type] || 'مشاركة';
  return box;
}

async function togglePostVisibility(post, card, button) {
  const nextHidden = !post.hidden;
  button.disabled = true;
  button.textContent = 'جارٍ التحديث...';
  try {
    const data = await api(`/api/admin/posts/${encodeURIComponent(post.id)}/visibility`, {
      method: 'PATCH',
      body: JSON.stringify({ hidden: nextHidden })
    });
    post.hidden = Boolean(data.hidden);
    card.replaceWith(renderPost(post));
    updatePostCount();
    showToast(post.hidden ? 'تم إخفاء المنشور عن الزوار.' : 'تم إظهار المنشور للزوار.', 'success');
  } catch (error) {
    showToast(error.message, 'error');
    if (error.status === 401) {
      renderLogin('انتهت الجلسة. سجّل الدخول مجددًا.');
      return;
    }
    button.disabled = false;
    button.textContent = post.hidden ? 'إظهار' : 'إخفاء';
  }
}

function renderPost(post) {
  const isHidden = Boolean(post.hidden);
  const card = make('article', isHidden ? 'admin-post is-hidden' : 'admin-post');
  card.dataset.type = post.type || '';
  card.dataset.id = post.id;
  card.append(mediaPreview(post));
  const body = make('div', 'admin-post-body');
  const meta = make('div', 'admin-post-meta');
  const kind = make('span', 'post-kind', TYPE_LABELS[post.type] || 'مشاركة');
  meta.append(kind, make('time', '', formatDate(post.createdAt)));
  if (isHidden) {
    meta.append(make('span', 'admin-hidden-badge', 'مخفي عن الزوار'));
  }
  body.append(meta);
  body.append(make('p', 'admin-post-content', previewText(post.content)));
  if (post.type === 'poll') {
    const options = post.options || [];
    const total = options.reduce((sum, option) => sum + Number(option.votes || 0), 0);
    const list = make('ul', 'admin-poll-summary');
    if (!options.length) list.append(make('li', '', 'لا توجد خيارات'));
    for (const option of options) {
      const item = document.createElement('li');
      item.append(make('span', '', option.label));
      const votes = make('b', '', `${option.votes} صوت`);
      item.append(votes);
      list.append(item);
    }
    const totalLine = document.createElement('li');
    totalLine.append(make('span', '', 'إجمالي الأصوات'), make('b', '', String(total)));
    list.append(totalLine);
    body.append(list);
  }
  const actions = make('div', 'admin-post-actions');
  const toggleBtn = make('button', 'button button-outline button-visibility', isHidden ? 'إظهار' : 'إخفاء');
  toggleBtn.type = 'button';
  toggleBtn.addEventListener('click', () => togglePostVisibility(post, card, toggleBtn));

  const del = make('button', 'button button-danger', 'حذف');
  del.type = 'button';
  del.addEventListener('click', () => openConfirm(post));

  actions.append(toggleBtn, del);
  card.append(body, actions);
  return card;
}

async function showDashboard() {
  logoutButton.hidden = false;
  setWritePostVisible(true);
  const intro = make('div', 'admin-intro');
  const headingWrap = make('div', 'section-heading admin-toolbar');
  const titles = document.createElement('div');
  titles.append(make('p', 'eyebrow', 'إدارة المحتوى'));
  titles.append(make('h1', '', 'المشاركات'));
  const actions = make('div', 'admin-toolbar-actions');
  const writeLink = make('a', 'button button-primary', 'اكتب منشورًا');
  writeLink.href = '/#composer';
  const count = make('p', 'admin-count', 'جارٍ التحميل...');
  count.id = 'postCount';
  actions.append(writeLink, count);
  headingWrap.append(titles, actions);
  intro.append(headingWrap);
  const list = make('div', 'admin-list');
  list.id = 'adminList';
  list.append(make('p', 'loading-state', 'جارٍ تحميل المشاركات...'));
  main.replaceChildren(intro, list);
  try {
    const data = await api('/api/admin/posts');
    list.replaceChildren();
    const posts = data.posts || [];
    if (!posts.length) {
      count.textContent = 'لا توجد مشاركات';
      list.append(make('p', 'empty-state', 'لا توجد مشاركات حاليًا.'));
      return;
    }
    for (const post of posts) list.append(renderPost(post));
    updatePostCount();
  } catch (error) {
    if (error.status === 401) {
      renderLogin('انتهت الجلسة. سجّل الدخول مجددًا.');
      showToast(error.message, 'error');
      return;
    }
    list.replaceChildren(make('p', 'empty-state', error.message || 'تعذر تحميل المشاركات.'));
  }
}

function openConfirm(post) {
  pendingDeleteId = post.id;
  const snippet = previewText(post.content);
  confirmText.textContent = `هل تريد حذف هذا المنشور نهائيًا؟ «${snippet}». لا يمكن التراجع عن هذا الإجراء.`;
  modal.hidden = false;
  confirmDelete.focus();
}

function closeConfirm() {
  pendingDeleteId = null;
  modal.hidden = true;
}

cancelDelete.addEventListener('click', closeConfirm);
modal.addEventListener('click', (event) => {
  if (event.target === modal) closeConfirm();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modal.hidden) closeConfirm();
});

confirmDelete.addEventListener('click', async () => {
  if (!pendingDeleteId) return;
  const id = pendingDeleteId;
  confirmDelete.disabled = true;
  confirmDelete.textContent = 'جارٍ الحذف...';
  try {
    await api(`/api/admin/posts/${encodeURIComponent(id)}`, { method: 'DELETE' });
    closeConfirm();
    showToast('تم حذف المنشور.', 'success');
    const card = main.querySelector(`.admin-post[data-id="${CSS.escape(id)}"]`);
    card?.remove();
    updatePostCount();
    const remaining = main.querySelectorAll('.admin-post').length;
    const list = document.querySelector('#adminList');
    if (list && remaining === 0) list.append(make('p', 'empty-state', 'لا توجد مشاركات حاليًا.'));
  } catch (error) {
    showToast(error.message, 'error');
    if (error.status === 401) {
      closeConfirm();
      renderLogin('انتهت الجلسة. سجّل الدخول مجددًا.');
    }
  } finally {
    confirmDelete.disabled = false;
    confirmDelete.textContent = 'حذف المنشور';
  }
});

logoutButton.addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); }
  catch { /* still return to the login screen */ }
  showToast('تم تسجيل الخروج.', 'info');
  renderLogin();
});

async function boot() {
  try {
    const status = await api('/api/admin/status');
    if (!status.enabled) return renderDisabled();
    if (status.authenticated) return showDashboard();
    renderLogin();
  } catch (error) {
    main.replaceChildren(make('p', 'empty-state', error.message || 'تعذر الاتصال بالخادم.'));
  }
}

boot();
