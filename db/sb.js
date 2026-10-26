// Tiny Supabase client over REST, for the server side only (uses the secret key).
const URL = process.env.SB_URL;
const KEY = process.env.SB_SECRET;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'content-type': 'application/json' };

async function call(method, path, body, extra = {}) {
  const res = await fetch(`${URL}${path}`, { method, headers: { ...H, ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

// PostgREST wants every row in a batch to have the same keys
const sameKeys = (rows) => { if (!Array.isArray(rows)) return rows; const keys = [...new Set(rows.flatMap(Object.keys))]; return rows.map((r) => Object.fromEntries(keys.map((k) => [k, r[k] === undefined ? null : r[k]]))); };

const rest = {
  select: (table, query = '') => call('GET', `/rest/v1/${table}?${query}`),
  insert: (table, rows, { upsert = false, onConflict } = {}) => call('POST', `/rest/v1/${table}${onConflict ? `?on_conflict=${onConflict}` : ''}`, sameKeys(rows), { Prefer: `return=representation${upsert ? ',resolution=merge-duplicates' : ''}` }),
  update: (table, query, patch) => call('PATCH', `/rest/v1/${table}?${query}`, patch, { Prefer: 'return=representation' }),
  remove: (table, query) => call('DELETE', `/rest/v1/${table}?${query}`, undefined, { Prefer: 'return=minimal' }),
};

async function insertBatched(table, rows, opts, size = 500) {
  const out = [];
  for (let i = 0; i < rows.length; i += size) out.push(...(await rest.insert(table, rows.slice(i, i + size), opts)));
  return out;
}

const admin = {
  listUsers: () => call('GET', '/auth/v1/admin/users?per_page=200'),
  createUser: (email, password) => call('POST', '/auth/v1/admin/users', { email, password, email_confirm: true }),
  updateUser: (id, patch) => call('PUT', `/auth/v1/admin/users/${id}`, patch),
};

module.exports = { rest, insertBatched, admin };
