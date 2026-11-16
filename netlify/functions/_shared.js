const { createClient } = require('@supabase/supabase-js');

const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY', 'ADMIN_EMAIL'];
function config() {
  for (const key of required) if (!process.env[key]) throw new Error(`Missing server configuration: ${key}`);
  return {
    url: process.env.SUPABASE_URL,
    anon: process.env.SUPABASE_ANON_KEY,
    service: process.env.SUPABASE_SERVICE_ROLE_KEY,
    adminEmail: process.env.ADMIN_EMAIL.trim().toLowerCase()
  };
}
function db() {
  const c = config();
  return createClient(c.url, c.service, { auth: { persistSession: false, autoRefreshToken: false } });
}
function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...extraHeaders },
    body: JSON.stringify(body)
  };
}
function readBody(event) {
  try { return JSON.parse(event.body || '{}'); } catch { throw Object.assign(new Error('Invalid JSON body'), { status: 400 }); }
}
function fail(error) {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  return json(status, { error: status >= 500 ? 'Server error' : error.message });
}
function validateText(value, label, max, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) {
    throw Object.assign(new Error(`Invalid ${label}`), { status: 400 });
  }
  return value.trim();
}
function bearer(event) {
  const header = event.headers.authorization || event.headers.Authorization || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) throw Object.assign(new Error('Authentication required'), { status: 401 });
  return match[1];
}
async function requireAdmin(event) {
  const c = config();
  const token = bearer(event);
  const client = createClient(c.url, c.anon, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await client.auth.getUser(token);
  const user = data?.user;
  if (error || !user || user.email?.toLowerCase() !== c.adminEmail || !user.email_confirmed_at) {
    throw Object.assign(new Error('Forbidden'), { status: 403 });
  }
  return user;
}
function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
module.exports = { config, db, json, readBody, fail, validateText, requireAdmin, escapeHtml };
