const SUPABASE_URL = 'https://zjsvrfudkigjvvhlehdh.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inpqc3ZyZnVka2lnanZ2aGxlaGRoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM5OTMxMDAsImV4cCI6MjEwOTU2OTEwMH0.Xvw_864IEYQKsx4HSc_QnDDgnRF4N_7_dudBhtSVR0M';
const OWNER_ID = '38fef214-197c-4508-9863-96e963509511';
const FUB_BASE = 'https://api.followupboss.com/v1';

function json(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

async function callerIsOwner(req) {
  const auth = req.headers.get('authorization') || '';
  const match = auth.match(/^Bearer\s+(.+)$/i);
  if (!match) return false;
  try {
    const res = await fetch(SUPABASE_URL + '/auth/v1/user', {
      headers: { apikey: SUPABASE_ANON_KEY, authorization: 'Bearer ' + match[1] }
    });
    if (!res.ok) return false;
    const user = await res.json();
    return !!(user && user.id === OWNER_ID);
  } catch (err) {
    return false;
  }
}

function slim(p) {
  const emails = Array.isArray(p.emails) ? p.emails : [];
  const phones = Array.isArray(p.phones) ? p.phones : [];
  const email = emails.find(e => e && e.value);
  const phone = phones.find(t => t && t.value);
  return {
    id: p.id,
    name: [p.firstName, p.lastName].filter(Boolean).join(' ') || p.name || '',
    stage: p.stage || '',
    tags: Array.isArray(p.tags) ? p.tags : [],
    source: p.source || '',
    email: email ? email.value : '',
    phone: phone ? phone.value : '',
    updated: p.updated || ''
  };
}

async function fubPeople(qs) {
  const key = process.env.FUB_API_KEY;
  const res = await fetch(FUB_BASE + '/people?limit=100&' + qs, {
    headers: { authorization: 'Basic ' + btoa(key + ':'), accept: 'application/json' }
  });
  if (!res.ok) return { error: 'fub_' + res.status, people: [] };
  const data = await res.json();
  const list = Array.isArray(data.people) ? data.people : [];
  return { people: list.map(slim), count: list.length };
}

export default async function fub(req) {
  try {
    if (req.method !== 'GET') return json({ error: 'method' }, 405);
    if (!process.env.FUB_API_KEY) return json({ error: 'unconfigured' }, 503);
    if (!(await callerIsOwner(req))) return json({ error: 'unauthorized' }, 401);
    const byStage = await fubPeople('stage=' + encodeURIComponent('Hot Prospect'));
    const byTag = await fubPeople('tags=' + encodeURIComponent('Hot'));
    return json({ hotByStage: byStage, hotByTag: byTag });
  } catch (err) {
    return json({ error: 'unavailable' }, 503);
  }
}

export const config = { path: '/fub/hot' };
