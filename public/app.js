const form = document.querySelector('#postForm');
const typeField = document.querySelector('#postType');
const contentField = document.querySelector('#postContent');
const mediaField = document.querySelector('#mediaField');
const mediaInput = document.querySelector('#mediaFile');
const pollField = document.querySelector('#pollField');
const optionsHost = document.querySelector('#pollOptions');
const formMessage = document.querySelector('#formMessage');
const feed = document.querySelector('#feed');
const submitButton = document.querySelector('#submitPost');
const MAX_OPTIONS = 6;

const MAX_MEDIA_BYTES = 25 * 1024 * 1024;
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const VIDEO_TYPES = new Set(['video/mp4', 'video/webm']);

async function uploadMediaToCloudinary(file, type) {
  if (file.size > MAX_MEDIA_BYTES) {
    throw new Error('حجم الملف يتجاوز الحد الأقصى وهو 25 ميغابايت.');
  }
  const allowed = type === 'video' ? VIDEO_TYPES : IMAGE_TYPES;
  if (file.type && !allowed.has(file.type)) {
    throw new Error('صيغة الملف غير مدعومة أو لا تطابق نوع المشاركة.');
  }
  const signResponse = await fetch('/api/uploads/sign', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ resourceType: type })
  });
  const sign = await signResponse.json().catch(() => ({}));
  if (!signResponse.ok) throw new Error(sign.error || 'تعذر تجهيز رفع الملف.');

  const payload = new FormData();
  payload.append('file', file);
  payload.append('api_key', sign.apiKey);
  payload.append('timestamp', String(sign.timestamp));
  payload.append('signature', sign.signature);
  payload.append('folder', sign.folder);
  payload.append('public_id', sign.publicId);
  payload.append('allowed_formats', sign.allowedFormats);

  const uploadResponse = await fetch(sign.uploadUrl, { method: 'POST', body: payload });
  const uploaded = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok || !uploaded.secure_url || !uploaded.public_id) {
    const message = (uploaded && uploaded.error && uploaded.error.message) || 'تعذر رفع الملف إلى التخزين الدائم. حاول مجددًا.';
    throw new Error(message);
  }
  return { mediaUrl: uploaded.secure_url, mediaPublicId: uploaded.public_id };
}


function getVoterId() {
  let id = localStorage.getItem('3bot-voter-id');
  if (!id) {
    id = crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = Math.random() * 16 | 0;
      return (char === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
    });
    localStorage.setItem('3bot-voter-id', id);
  }
  return id;
}

function addOption(value = '') {
  if (optionsHost.children.length >= MAX_OPTIONS) return;
  const input = document.createElement('input');
  input.className = 'option-input';
  input.type = 'text';
  input.maxLength = 100;
  input.placeholder = `الخيار ${optionsHost.children.length + 1}`;
  input.setAttribute('aria-label', `خيار استطلاع ${optionsHost.children.length + 1}`);
  input.value = value;
  optionsHost.append(input);
  document.querySelector('#addOption').disabled = optionsHost.children.length >= MAX_OPTIONS;
}

function syncComposer() {
  const type = typeField.value;
  const isMedia = type === 'image' || type === 'video';
  mediaField.hidden = !isMedia;
  pollField.hidden = type !== 'poll';
  mediaInput.accept = type === 'video' ? 'video/mp4,video/webm' : 'image/jpeg,image/png,image/webp,image/gif';
  document.querySelector('#mediaLabel').textContent = type === 'video' ? 'اختر فيديو (MP4 أو WEBM)' : 'اختر صورة';
  contentField.placeholder = type === 'poll' ? 'اكتب سؤال الاستطلاع...' : (isMedia ? 'أضف وصفًا اختياريًا...' : 'اكتب فكرتك هنا...');
  contentField.required = type === 'text' || type === 'poll';
  if (type === 'poll' && optionsHost.children.length === 0) { addOption(); addOption(); }
}

typeField.addEventListener('change', syncComposer);
document.querySelector('#addOption').addEventListener('click', () => addOption());
contentField.addEventListener('input', () => {
  document.querySelector('#charCount').textContent = `${contentField.value.length} / 720`;
});
document.querySelector('#refreshButton').addEventListener('click', loadPosts);

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

function renderPost(post) {
  const card = make('article', 'post-card');
  card.dataset.type = post.type || '';
  const meta = make('div', 'post-meta');
  const kind = {text:'منشور نصي',image:'صورة',video:'فيديو',poll:'استطلاع رأي'}[post.type] || 'مشاركة';
  meta.append(make('span', 'post-kind', kind));
  const date = new Date(post.createdAt);
  meta.append(make('time', '', Number.isNaN(date.valueOf()) ? '' : new Intl.DateTimeFormat('ar', {dateStyle:'medium', timeStyle:'short'}).format(date)));
  card.append(meta);
  if (post.content) card.append(make('p', 'post-content', post.content));
  if (post.type === 'image' && post.mediaUrl) {
    const image = document.createElement('img'); image.className = 'post-image'; image.src = post.mediaUrl; image.alt = post.content || 'صورة منشورة'; image.loading = 'lazy'; card.append(image);
  }
  if (post.type === 'video' && post.mediaUrl) {
    const video = document.createElement('video'); video.className = 'post-video'; video.src = post.mediaUrl; video.controls = true; video.preload = 'metadata'; card.append(video);
  }
  if (post.type === 'poll') renderPoll(card, post);
  return card;
}

function renderPoll(card, post) {
  const options = post.options || [];
  const total = options.reduce((sum, option) => sum + Number(option.votes || 0), 0);
  const voted = localStorage.getItem(`3bot-voted-${post.id}`) === 'yes';
  const list = make('div', 'poll-list');
  for (const option of options) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `poll-option${voted ? ' voted' : ''}`; button.disabled = voted;
    const ratio = total ? Math.round((Number(option.votes) / total) * 100) : 0;
    const bar = make('span', 'poll-bar'); bar.style.width = `${ratio}%`;
    button.append(bar, make('span', 'poll-option-label', option.label), make('span', 'poll-vote-count', voted || total ? `${ratio}% · ${option.votes}` : 'صوّت'));
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        const response = await fetch(`/api/posts/${encodeURIComponent(post.id)}/vote`, {
          method: 'POST', headers: {'Content-Type':'application/json'},
          body: JSON.stringify({optionId: option.id, voterId: getVoterId()})
        });
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'تعذر تسجيل التصويت.');
        localStorage.setItem(`3bot-voted-${post.id}`, 'yes');
        showToast('تم تسجيل صوتك بنجاح.', 'success');
        await loadPosts();
      } catch (error) {
        button.disabled = false;
        showMessage(error.message, true);
      }
    });
    list.append(button);
  }
  card.append(list, make('p', 'vote-hint', voted ? 'تم تسجيل تصويتك من هذا المتصفح.' : 'يمكن التصويت مرة واحدة من هذا المتصفح.'));
}

async function loadPosts() {
  feed.replaceChildren(make('p', 'loading-state', 'جارٍ تحميل المشاركات...'));
  try {
    const response = await fetch('/api/posts', {headers:{'Accept':'application/json'}});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'تعذر تحميل المشاركات.');
    feed.replaceChildren();
    if (!data.posts.length) { feed.append(make('p', 'empty-state', 'لا توجد مشاركات حتى الآن.')); return; }
    for (const post of data.posts) feed.append(renderPost(post));
  } catch (error) {
    feed.replaceChildren(make('p', 'empty-state', error.message || 'تعذر الاتصال بالموقع. حاول التحديث.'));
  }
}

function showMessage(text, isError = false) {
  formMessage.textContent = text;
  formMessage.className = `form-message ${isError ? 'error' : 'success'}`;
  showToast(text, isError ? 'error' : 'success');
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const type = typeField.value;
  const content = contentField.value.trim();
  if ((type === 'text' || type === 'poll') && !content) return showMessage(type === 'poll' ? 'اكتب سؤال الاستطلاع أولًا.' : 'اكتب نص المنشور أولًا.', true);
  const options = [...optionsHost.querySelectorAll('input')].map((input) => input.value.trim()).filter(Boolean);
  if (type === 'poll' && (options.length < 2 || options.length > MAX_OPTIONS)) return showMessage('أضف خيارين على الأقل للاستطلاع.', true);
  const file = mediaInput.files[0];
  if ((type === 'image' || type === 'video') && !file) return showMessage('اختر ملفًا قبل النشر.', true);
  if (file && file.size > MAX_MEDIA_BYTES) return showMessage('حجم الملف يتجاوز الحد الأقصى وهو 25 ميغابايت.', true);

  submitButton.disabled = true; submitButton.textContent = 'جارٍ النشر...'; formMessage.textContent = '';
  try {
    let response;
    if (type === 'image' || type === 'video') {
      const uploaded = await uploadMediaToCloudinary(file, type);
      response = await fetch('/api/posts', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, content, mediaUrl: uploaded.mediaUrl, mediaPublicId: uploaded.mediaPublicId })
      });
    } else {
      response = await fetch('/api/posts', {method:'POST', credentials:'same-origin', headers:{'Content-Type':'application/json'}, body:JSON.stringify({type, content, options})});
    }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'تعذر نشر المشاركة.');
    form.reset(); optionsHost.replaceChildren(); syncComposer();
    document.querySelector('#charCount').textContent = '0 / 720';
    showMessage('تم نشر مشاركتك بنجاح.');
    await loadPosts();
    document.querySelector('#feed').scrollIntoView({behavior:'smooth', block:'start'});
  } catch (error) {
    showMessage(error.message || 'حدث خطأ أثناء النشر.', true);
  } finally {
    submitButton.disabled = false; submitButton.textContent = 'نشر المشاركة';
  }
});

async function refreshPublisherMode() {
  let isAdmin = false;
  try {
    const response = await fetch('/api/admin/session', {
      headers: { Accept: 'application/json' },
      credentials: 'same-origin'
    });
    const data = await response.json().catch(() => ({}));
    isAdmin = Boolean(data.admin);
  } catch {
    isAdmin = false;
  }
  document.body.classList.toggle('is-publisher', isAdmin);
  document.querySelector('#contentArea')?.classList.toggle('has-composer', isAdmin);
  for (const el of document.querySelectorAll('[data-publisher-only]')) {
    el.hidden = !isAdmin;
  }
  return isAdmin;
}

refreshPublisherMode().then((isAdmin) => {
  if (isAdmin) syncComposer();
  loadPosts();
  if (isAdmin && location.hash === '#composer') {
    document.getElementById('composer')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
});
