import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import rateLimit from 'express-rate-limit';
import multer from 'multer';
import mysql from 'mysql2/promise';
import { fileTypeFromBuffer } from 'file-type';
import { v2 as cloudinary } from 'cloudinary';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');
const app = express();
const port = Number(process.env.PORT || 3000);
const maxMediaBytes = 25 * 1024 * 1024;
const postTypes = new Set(['text', 'image', 'video', 'poll']);
const imageMimeTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const videoMimeTypes = new Set(['video/mp4', 'video/webm']);
const IMAGE_FORMATS = 'jpg,png,webp,gif';
const VIDEO_FORMATS = 'mp4,webm';
const MEDIA_FOLDER = '3bot-blog/posts';
const SESSION_COOKIE = '3bot_admin';
const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_CONTENT_LENGTH = 100000;
const JSON_BODY_LIMIT = '2mb';

const ENV_KEYS_TO_CLEAN = [
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'DB_HOST',
  'DB_PORT',
  'DB_USER',
  'DB_PASSWORD',
  'DB_NAME',
  'DATABASE_URL',
  'DB_SSL',
  'DB_SSL_MODE',
  'ADMIN_PASSWORD',
  'SESSION_SECRET'
];

export function cleanEnvValue(value) {
  if (value == null) return value;
  let s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2)
    || (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    s = s.slice(1, -1).trim();
  }
  return s;
}

export function normalizeProcessEnv(env = process.env) {
  for (const key of ENV_KEYS_TO_CLEAN) {
    if (env[key] != null && env[key] !== '') {
      env[key] = cleanEnvValue(env[key]);
    }
  }
  return env;
}

export function cloudinarySecretIssues(secret = process.env.CLOUDINARY_API_SECRET, apiKey = process.env.CLOUDINARY_API_KEY) {
  const issues = [];
  if (!secret) return issues;
  if (secret.includes('*')) issues.push('contains_asterisk');
  if (/\s/.test(secret)) issues.push('contains_whitespace');
  if (apiKey && secret === apiKey) issues.push('equals_api_key');
  if (secret.length < 20 || secret.length > 40) issues.push('unexpected_length');
  return issues;
}

function logCloudinaryConfigCheck() {
  const secret = process.env.CLOUDINARY_API_SECRET || '';
  const issues = cloudinarySecretIssues(secret, process.env.CLOUDINARY_API_KEY);
  if (!issues.length) return;
  console.error(
    'Cloudinary configuration warning: API_SECRET looks malformed (%s). Length=%s. Paste the real secret from the Cloudinary console, not the masked value.',
    issues.join(','),
    secret.length
  );
}

normalizeProcessEnv();
logCloudinaryConfigCheck();

function isTlsDisabled(sslMode) {
  return ['disabled', 'disable', 'false', '0'].includes(String(sslMode || '').toLowerCase());
}

function poolOptions({ host, port, user, password, database, tlsDisabled }) {
  const defaultLimit = process.env.VERCEL ? 1 : 5;
  const connectionLimit = Math.max(1, Number(process.env.DB_CONNECTION_LIMIT || defaultLimit) || defaultLimit);
  return {
    host,
    port,
    user,
    password,
    database,
    ssl: tlsDisabled ? undefined : { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    waitForConnections: true,
    connectionLimit,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    idleTimeout: 60000,
    maxIdle: connectionLimit,
    charset: 'utf8mb4',
    supportBigNumbers: true,
    bigNumberStrings: true,
    timezone: 'Z'
  };
}

function createPool() {
  if (process.env.DATABASE_URL) {
    const dsn = new URL(process.env.DATABASE_URL);
    if (!['mysql:', 'mysqls:'].includes(dsn.protocol)) throw new Error('database_url_invalid');
    const sslMode = dsn.searchParams.get('ssl-mode') || dsn.searchParams.get('ssl') || '';
    return mysql.createPool(poolOptions({
      host: dsn.hostname,
      port: Number(dsn.port || 3306),
      user: decodeURIComponent(dsn.username),
      password: decodeURIComponent(dsn.password),
      database: decodeURIComponent(dsn.pathname.replace(/^\//, '')),
      tlsDisabled: isTlsDisabled(sslMode)
    }));
  }
  const host = (process.env.DB_HOST || '').trim();
  const user = (process.env.DB_USER || '').trim();
  const password = process.env.DB_PASSWORD;
  const database = (process.env.DB_NAME || '').trim();
  if (!host || !user || !password || !database) return null;
  return mysql.createPool(poolOptions({
    host,
    port: Number(process.env.DB_PORT || 4000),
    user,
    password,
    database,
    tlsDisabled: isTlsDisabled(process.env.DB_SSL || process.env.DB_SSL_MODE)
  }));
}

const pool = createPool();

async function initializeSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS posts (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    post_type ENUM('text','image','video','poll') NOT NULL,
    content MEDIUMTEXT NOT NULL,
    media_url VARCHAR(512) NULL,
    is_hidden TINYINT(1) NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_posts_created_at (created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS poll_options (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT UNSIGNED NOT NULL,
    option_label VARCHAR(100) NOT NULL,
    votes_count INT UNSIGNED NOT NULL DEFAULT 0,
    INDEX idx_poll_options_post (post_id),
    CONSTRAINT fk_poll_options_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await pool.query(`CREATE TABLE IF NOT EXISTS poll_votes (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    post_id BIGINT UNSIGNED NOT NULL,
    option_id BIGINT UNSIGNED NOT NULL,
    voter_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_poll_voter (post_id, voter_id),
    INDEX idx_poll_votes_option (option_id),
    CONSTRAINT fk_poll_votes_post FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    CONSTRAINT fk_poll_votes_option FOREIGN KEY (option_id) REFERENCES poll_options(id) ON DELETE CASCADE
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await ensureMediaPublicIdColumn();
  await ensureIsHiddenColumn();
  await ensureContentColumnType();
}

async function ensureMediaPublicIdColumn() {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'posts'
       AND COLUMN_NAME = 'media_public_id'`
  );
  if (Number(rows[0]?.count || 0) === 0) {
    await pool.query('ALTER TABLE posts ADD COLUMN media_public_id VARCHAR(255) NULL');
  }
}

async function ensureIsHiddenColumn() {
  const [rows] = await pool.query(
    `SELECT COUNT(*) AS count
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'posts'
       AND COLUMN_NAME = 'is_hidden'`
  );
  if (Number(rows[0]?.count || 0) === 0) {
    await pool.query('ALTER TABLE posts ADD COLUMN is_hidden TINYINT(1) NOT NULL DEFAULT 0');
  }
}

async function ensureContentColumnType() {
  const [rows] = await pool.query(
    `SELECT DATA_TYPE AS dataType
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'posts'
       AND COLUMN_NAME = 'content'`
  );
  const dataType = String(rows[0]?.dataType || rows[0]?.DATA_TYPE || '').toLowerCase();
  if (dataType === 'mediumtext' || dataType === 'longtext') return;
  await pool.query(
    'ALTER TABLE posts MODIFY COLUMN content MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NOT NULL'
  );
}

let schemaPromise = null;
export async function ensureSchema() {
  if (!pool) throw new Error('database_configuration_missing');
  if (!schemaPromise) schemaPromise = initializeSchema();
  try {
    await schemaPromise;
  } catch (error) {
    schemaPromise = null;
    throw error;
  }
}

function isCloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_CLOUD_NAME
    && process.env.CLOUDINARY_API_KEY
    && process.env.CLOUDINARY_API_SECRET
  );
}

function configureCloudinary() {
  cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
    secure: true
  });
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isOwnedCloudinaryAsset(url, publicId, expectedType) {
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  if (!cloud || !url || !publicId) return false;
  const prefix = `${MEDIA_FOLDER}/`;
  if (!String(publicId).startsWith(prefix)) return false;
  const leaf = String(publicId).slice(prefix.length);
  if (!leaf || leaf.includes('/') || leaf.includes('..') || leaf.includes('%') || leaf.includes('\\')) return false;
  let parsed;
  try { parsed = new URL(String(url)); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'res.cloudinary.com') return false;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return false;
  const resource = expectedType === 'video' ? 'video' : 'image';
  const allowedExt = expectedType === 'video' ? 'mp4|webm' : 'jpg|jpeg|png|webp|gif';
  const pattern = new RegExp(
    `^/${escapeRegExp(cloud)}/${resource}/upload/v\\d+/${escapeRegExp(MEDIA_FOLDER)}/${escapeRegExp(leaf)}(?:\\.(?:${allowedExt}))?$`,
    'i'
  );
  try {
    return pattern.test(decodeURIComponent(parsed.pathname));
  } catch {
    return false;
  }
}

function isAdminEnabled() {
  return Boolean(process.env.ADMIN_PASSWORD && process.env.SESSION_SECRET);
}

function safeEqualString(provided, expected) {
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  const n = Math.max(a.length, b.length, 1);
  const pa = Buffer.alloc(n);
  const pb = Buffer.alloc(n);
  if (a.length) a.copy(pa);
  if (b.length) b.copy(pb);
  const contentEqual = crypto.timingSafeEqual(pa, pb);
  return contentEqual && a.length === b.length;
}

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifySession(token) {
  if (!token || !process.env.SESSION_SECRET) return null;
  try {
    const dot = String(token).indexOf('.');
    if (dot < 1) return null;
    const body = String(token).slice(0, dot);
    const sig = String(token).slice(dot + 1);
    const expected = crypto.createHmac('sha256', process.env.SESSION_SECRET).update(body).digest('base64url');
    if (!safeEqualString(sig, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!payload || payload.role !== 'admin' || typeof payload.exp !== 'number') return null;
    if (payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try { out[key] = decodeURIComponent(value); }
    catch { out[key] = value; }
  }
  return out;
}

function isHttpsRequest(req) {
  return Boolean(req.secure || String(req.get('x-forwarded-proto') || '').split(',')[0].trim() === 'https');
}

function cookieOptions(req, token, maxAgeSec) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAgeSec}`
  ];
  if (isHttpsRequest(req)) parts.push('Secure');
  return parts.join('; ');
}

function setSessionCookie(req, res, token) {
  res.setHeader('Set-Cookie', cookieOptions(req, token, Math.floor(SESSION_MAX_AGE_MS / 1000)));
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', cookieOptions(req, '', 0));
}

function readAdminSession(req) {
  if (!isAdminEnabled()) return null;
  return verifySession(parseCookies(req)[SESSION_COOKIE]);
}

function requireAdmin(req, res, next) {
  if (!isAdminEnabled()) {
    return res.status(503).json({ error: 'لوحة الإدارة غير مفعّلة. عيّن ADMIN_PASSWORD وSESSION_SECRET في متغيرات البيئة.' });
  }
  const session = readAdminSession(req);
  if (!session) return res.status(401).json({ error: 'يجب تسجيل الدخول أولًا.' });
  req.adminSession = session;
  next();
}

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
const skipDatabasePaths = new Set([
  '/api/admin/session',
  '/api/admin/status',
  '/api/admin/login',
  '/api/admin/logout'
]);

app.use((req, res, next) => {
  if (skipDatabasePaths.has(req.path) || (req.path !== '/_health' && !req.path.startsWith('/api/'))) return next();
  ensureSchema().then(() => next()).catch(() => {
    if (req.path === '/_health') return res.status(503).json({ ok: false });
    res.status(503).json({ error: 'تعذر الاتصال بقاعدة البيانات.' });
  });
});
app.use(express.json({ limit: JSON_BODY_LIMIT }));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'طلبات كثيرة خلال فترة قصيرة. حاول مجددًا بعد قليل.' }
});
const createPostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 12,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'وصلت إلى حد النشر المؤقت. حاول مجددًا بعد قليل.' }
});
const uploadSignLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'طلبات كثيرة لتجهيز رفع الملفات. حاول مجددًا بعد قليل.' }
});
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 5,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: { error: 'محاولات كثيرة لتسجيل الدخول. حاول مجددًا بعد 15 دقيقة.' }
});
app.use('/api/', apiLimiter);

const mediaUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: maxMediaBytes, files: 1, fields: 8, fieldSize: 8000 }
});
function parseMultipartPost(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  mediaUpload.single('media')(req, res, next);
}

app.get('/_health', async (_req, res) => {
  try {
    if (!pool) throw new Error('database_configuration_missing');
    await pool.query('SELECT 1');
    res.status(200).json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

function mapPost(post, optionsByPost) {
  return {
    id: String(post.id),
    type: post.type,
    content: post.content,
    mediaUrl: post.mediaUrl || null,
    createdAt: post.createdAt instanceof Date ? post.createdAt.toISOString() : post.createdAt,
    isHidden: Boolean(Number(post.isHidden)),
    options: optionsByPost.get(String(post.id)) || []
  };
}

async function loadPostsWithOptions(limit, { includeHidden = false } = {}) {
  const visibilitySql = includeHidden ? '' : 'WHERE is_hidden = 0';
  const [posts] = await pool.query(
    `SELECT id, post_type AS type, content, media_url AS mediaUrl, created_at AS createdAt, is_hidden AS isHidden
     FROM posts ${visibilitySql} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [limit]
  );
  if (!posts.length) return [];
  const ids = posts.map((post) => post.id);
  const [options] = await pool.query(
    `SELECT id, post_id AS postId, option_label AS label, votes_count AS votes
     FROM poll_options WHERE post_id IN (?) ORDER BY id`,
    [ids]
  );
  const optionsByPost = new Map();
  for (const option of options) {
    const key = String(option.postId);
    if (!optionsByPost.has(key)) optionsByPost.set(key, []);
    optionsByPost.get(key).push({ id: String(option.id), label: option.label, votes: Number(option.votes) });
  }
  return posts.map((post) => mapPost(post, optionsByPost));
}

app.get('/api/posts', async (_req, res) => {
  try {
    const posts = await loadPostsWithOptions(60);
    res.json({ posts });
  } catch {
    res.status(500).json({ error: 'تعذر تحميل المشاركات الآن.' });
  }
});

function uploadBufferToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error || !result?.secure_url) {
        reject(error || new Error('storage_upload_failed'));
        return;
      }
      resolve(result);
    });
    stream.end(buffer);
  });
}

async function storeMedia(file, expectedType) {
  if (!isCloudinaryConfigured()) throw new Error('storage_unavailable');
  const detected = await fileTypeFromBuffer(file.buffer);
  const allowed = expectedType === 'image' ? imageMimeTypes : videoMimeTypes;
  if (!detected || !allowed.has(detected.mime)) throw new Error('unsupported_media');
  configureCloudinary();
  const resourceType = expectedType === 'video' ? 'video' : 'image';
  try {
    const result = await uploadBufferToCloudinary(file.buffer, {
      folder: MEDIA_FOLDER,
      public_id: crypto.randomUUID(),
      resource_type: resourceType,
      allowed_formats: expectedType === 'video' ? VIDEO_FORMATS : IMAGE_FORMATS,
      timeout: 60000
    });
    return { url: result.secure_url, publicId: result.public_id };
  } catch (error) {
    if (error?.message === 'unsupported_media') throw error;
    throw new Error('storage_upload_failed');
  }
}

async function destroyCloudinaryAsset(publicId, postType) {
  if (!publicId || !isCloudinaryConfigured()) return;
  configureCloudinary();
  const resourceType = postType === 'video' ? 'video' : 'image';
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: resourceType, invalidate: true });
  } catch {
    // Keep the database delete even if remote deletion fails.
  }
}

app.post('/api/uploads/sign', uploadSignLimiter, requireAdmin, (req, res) => {
  if (!isCloudinaryConfigured()) {
    return res.status(503).json({ error: 'رفع الوسائط غير متاح حاليًا لأن خدمة التخزين غير مُعدّة.' });
  }
  if ((process.env.CLOUDINARY_API_SECRET || '').includes('*')) {
    return res.status(500).json({ error: 'إعداد التخزين غير صالح. يبدو أن سر Cloudinary نُسخ بشكل غير صحيح. الصق القيمة الحقيقية من لوحة Cloudinary، وليس القيمة المقنّعة التي تحتوي على علامة *.' });
  }
  const resourceType = String(req.body?.resourceType || '');
  if (resourceType !== 'image' && resourceType !== 'video') {
    return res.status(400).json({ error: 'نوع الملف غير صالح.' });
  }
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = crypto.randomUUID();
  const allowedFormats = resourceType === 'video' ? VIDEO_FORMATS : IMAGE_FORMATS;
  const paramsToSign = {
    timestamp,
    folder: MEDIA_FOLDER,
    public_id: publicId,
    allowed_formats: allowedFormats
  };
  configureCloudinary();
  // Browser unsigned/signed uploads are verified by Cloudinary with SHA-1 and signature version 1
  // (unencoded param string). Be explicit so a future SDK default cannot change the signed string.
  const signature = cloudinary.utils.api_sign_request(
    paramsToSign,
    process.env.CLOUDINARY_API_SECRET,
    'sha1',
    1
  );
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  res.json({
    cloudName,
    apiKey: process.env.CLOUDINARY_API_KEY,
    timestamp,
    signature,
    folder: MEDIA_FOLDER,
    publicId,
    resourceType,
    allowedFormats,
    maxFileBytes: maxMediaBytes,
    uploadUrl: `https://api.cloudinary.com/v1_1/${encodeURIComponent(cloudName)}/${resourceType}/upload`
  });
});

app.post('/api/posts', createPostLimiter, requireAdmin, parseMultipartPost, async (req, res) => {
  const type = String(req.body?.type || '');
  const content = String(req.body?.content || '').trim();
  if (!postTypes.has(type)) return res.status(400).json({ error: 'نوع المشاركة غير صالح.' });
  if (content.length > MAX_CONTENT_LENGTH) return res.status(400).json({ error: 'النص أطول من الحد المسموح. اختصر المنشور ثم حاول مجددًا.' });
  if ((type === 'text' || type === 'poll') && !content) return res.status(400).json({ error: 'اكتب نص المشاركة أولًا.' });

  let options = [];
  if (type === 'poll') {
    try { options = typeof req.body.options === 'string' ? JSON.parse(req.body.options) : req.body.options; }
    catch { return res.status(400).json({ error: 'خيارات الاستطلاع غير صالحة.' }); }
    if (!Array.isArray(options)) return res.status(400).json({ error: 'خيارات الاستطلاع غير صالحة.' });
    options = [...new Set(options.map((option) => String(option).trim()).filter(Boolean))];
    if (options.length < 2 || options.length > 6 || options.some((option) => option.length > 100)) {
      return res.status(400).json({ error: 'أضف من خيارين إلى 6 خيارات، بحد أقصى 100 حرف لكل خيار.' });
    }
  }

  let mediaUrl = null;
  let mediaPublicId = null;
  if (type === 'image' || type === 'video') {
    if (req.file) {
      try {
        const stored = await storeMedia(req.file, type);
        mediaUrl = stored.url;
        mediaPublicId = stored.publicId;
      } catch (error) {
        if (error.message === 'unsupported_media') return res.status(415).json({ error: 'صيغة الملف غير مدعومة أو لا تطابق نوع المشاركة.' });
        if (error.message === 'storage_unavailable') return res.status(503).json({ error: 'رفع الوسائط غير متاح حاليًا لأن خدمة التخزين غير مُعدّة.' });
        return res.status(502).json({ error: 'تعذر رفع الملف إلى التخزين الدائم. حاول مجددًا.' });
      }
    } else {
      const providedUrl = String(req.body?.mediaUrl || '').trim();
      const providedId = String(req.body?.mediaPublicId || '').trim();
      if (!providedUrl || !providedId) return res.status(400).json({ error: 'اختر ملف الوسائط المطلوب.' });
      if (!isCloudinaryConfigured()) return res.status(503).json({ error: 'رفع الوسائط غير متاح حاليًا لأن خدمة التخزين غير مُعدّة.' });
      if (!isOwnedCloudinaryAsset(providedUrl, providedId, type)) {
        return res.status(400).json({ error: 'رابط الوسائط غير صالح أو لا ينتمي إلى حساب التخزين.' });
      }
      mediaUrl = providedUrl;
      mediaPublicId = providedId;
    }
  }

  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [result] = await connection.execute(
      'INSERT INTO posts (post_type, content, media_url, media_public_id) VALUES (?, ?, ?, ?)',
      [type, content, mediaUrl, mediaPublicId]
    );
    const postId = result.insertId;
    if (type === 'poll') {
      for (const label of options) await connection.execute('INSERT INTO poll_options (post_id, option_label) VALUES (?, ?)', [postId, label]);
    }
    await connection.commit();
    res.status(201).json({ id: String(postId) });
  } catch {
    if (connection) await connection.rollback().catch(() => {});
    res.status(500).json({ error: 'تعذر حفظ المشاركة الآن.' });
  } finally {
    connection?.release();
  }
});

app.post('/api/posts/:id/vote', async (req, res) => {
  const postId = String(req.params.id);
  const optionId = String(req.body?.optionId || '');
  const voterId = String(req.body?.voterId || '').toLowerCase();
  const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  if (!/^\d{1,20}$/.test(postId) || !/^\d{1,20}$/.test(optionId) || !uuidPattern.test(voterId)) {
    return res.status(400).json({ error: 'بيانات التصويت غير صالحة.' });
  }
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [poll] = await connection.execute("SELECT id FROM posts WHERE id = ? AND post_type = 'poll' AND is_hidden = 0 FOR UPDATE", [postId]);
    if (!poll.length) { await connection.rollback(); return res.status(404).json({ error: 'الاستطلاع غير موجود.' }); }
    const [option] = await connection.execute('SELECT id FROM poll_options WHERE id = ? AND post_id = ? FOR UPDATE', [optionId, postId]);
    if (!option.length) { await connection.rollback(); return res.status(400).json({ error: 'الخيار لا يتبع هذا الاستطلاع.' }); }
    await connection.execute('INSERT INTO poll_votes (post_id, option_id, voter_id) VALUES (?, ?, ?)', [postId, optionId, voterId]);
    await connection.execute('UPDATE poll_options SET votes_count = votes_count + 1 WHERE id = ?', [optionId]);
    await connection.commit();
    res.json({ ok: true });
  } catch (error) {
    if (connection) await connection.rollback().catch(() => {});
    if (error?.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'تم تسجيل تصويتك لهذا الاستطلاع مسبقًا من هذا المتصفح.' });
    res.status(500).json({ error: 'تعذر تسجيل التصويت الآن.' });
  } finally {
    connection?.release();
  }
});

app.get('/api/admin/session', (req, res) => {
  res.json({ admin: Boolean(readAdminSession(req)) });
});

app.get('/api/admin/status', (req, res) => {
  res.json({ enabled: isAdminEnabled(), authenticated: Boolean(readAdminSession(req)) });
});

app.post('/api/admin/login', loginLimiter, (req, res) => {
  if (!isAdminEnabled()) {
    return res.status(503).json({ error: 'لوحة الإدارة غير مفعّلة. عيّن ADMIN_PASSWORD وSESSION_SECRET في متغيرات البيئة.' });
  }
  const password = String(req.body?.password || '');
  if (!safeEqualString(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: 'كلمة المرور غير صحيحة.' });
  }
  const token = signSession({ role: 'admin', exp: Date.now() + SESSION_MAX_AGE_MS });
  setSessionCookie(req, res, token);
  res.json({ ok: true });
});

app.post('/api/admin/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get('/api/admin/posts', requireAdmin, async (_req, res) => {
  try {
    const posts = await loadPostsWithOptions(200, { includeHidden: true });
    res.json({ posts });
  } catch {
    res.status(500).json({ error: 'تعذر تحميل المشاركات الآن.' });
  }
});

app.patch('/api/admin/posts/:id/visibility', requireAdmin, async (req, res) => {
  const postId = String(req.params.id);
  if (!/^\d{1,20}$/.test(postId)) return res.status(400).json({ error: 'معرّف المنشور غير صالح.' });
  if (typeof req.body?.hidden !== 'boolean') {
    return res.status(400).json({ error: 'قيمة الإخفاء غير صالحة.' });
  }
  const isHidden = req.body.hidden;
  try {
    const [rows] = await pool.execute('SELECT id FROM posts WHERE id = ?', [postId]);
    if (!rows.length) return res.status(404).json({ error: 'المنشور غير موجود.' });
    await pool.execute('UPDATE posts SET is_hidden = ? WHERE id = ?', [isHidden ? 1 : 0, postId]);
    res.json({ ok: true, id: postId, isHidden });
  } catch {
    res.status(500).json({ error: 'تعذر تحديث ظهور المنشور الآن.' });
  }
});

app.delete('/api/admin/posts/:id', requireAdmin, async (req, res) => {
  const postId = String(req.params.id);
  if (!/^\d{1,20}$/.test(postId)) return res.status(400).json({ error: 'معرّف المنشور غير صالح.' });
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      'SELECT id, post_type, media_public_id FROM posts WHERE id = ? FOR UPDATE',
      [postId]
    );
    if (!rows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'المنشور غير موجود.' });
    }
    const post = rows[0];
    await connection.execute('DELETE FROM posts WHERE id = ?', [postId]);
    await connection.commit();
    connection.release();
    connection = null;
    await destroyCloudinaryAsset(post.media_public_id, post.post_type);
    res.json({ ok: true });
  } catch {
    if (connection) await connection.rollback().catch(() => {});
    res.status(500).json({ error: 'تعذر حذف المنشور الآن.' });
  } finally {
    connection?.release();
  }
});

app.get('/admin', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.sendFile(path.join(publicDir, 'admin.html'));
});

app.use(express.static(publicDir, { index: 'index.html', etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
app.use((_req, res) => res.status(404).json({ error: 'الصفحة غير موجودة.' }));
app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'حجم الملف يتجاوز الحد الأقصى وهو 25 ميغابايت.' });
    return res.status(400).json({ error: 'تعذر قراءة ملف الوسائط.' });
  }
  if (error?.type === 'entity.too.large' || error?.status === 413) {
    return res.status(413).json({ error: 'حجم المنشور أكبر من المسموح.' });
  }
  res.status(500).json({ error: 'حدث خطأ غير متوقع.' });
});

export { app };

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === __filename;
  } catch {
    return false;
  }
}

async function start() {
  app.listen(port, '0.0.0.0', () => console.log(`Application listening on port ${port}`));
  try {
    await ensureSchema();
  } catch (error) {
    console.error(`Database is not ready: ${error.message === 'database_configuration_missing' ? 'database configuration missing' : 'database initialization error'}`);
  }
}

if (isDirectRun()) {
  start().catch(async (error) => {
    console.error(`Application startup failed: ${error.message === 'database_configuration_missing' ? 'database configuration missing' : 'database initialization error'}`);
    if (pool) await pool.end().catch(() => {});
    process.exit(1);
  });
}
