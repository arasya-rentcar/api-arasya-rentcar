// Helpers for the end-to-end checks (see README.md). Local stack only.
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../package.json', import.meta.url));
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

export const BASE = (process.env.E2E_API || 'http://localhost:3999') + '/api/v1';
export const MOCK = process.env.E2E_MOCK || 'http://localhost:4600';
const DB = process.env.E2E_DATABASE_URL;

// The checks create orders, drivers and payments. Never against production.
const isLocal = (u) => /^(https?:\/\/)?(localhost|127\.0\.0\.1)([:/]|$)/.test(u.replace(/^postgresql:\/\/[^@]*@/, ''));
if (!DB) throw new Error('E2E_DATABASE_URL is required (a throwaway local database)');
if (!process.env.E2E_ALLOW_REMOTE && (!isLocal(BASE) || !isLocal(DB))) {
  throw new Error(`Refusing to run against a non-local API or database (${BASE}). Set E2E_ALLOW_REMOTE=1 only for a disposable copy.`);
}

export const prisma = new PrismaClient({ datasources: { db: { url: DB } } });

let pass = 0;
let fail = 0;
let known = 0;
export function check(name, cond, detail = '') {
  if (cond) pass++;
  else fail++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}
/** A known, documented issue: reported but does not fail the run. Flags it once fixed. */
export function knownIssue(issue, name, cond, detail = '') {
  if (cond) {
    console.log(`FIXED ${name}  — ${issue} now behaves; turn this into a normal check`);
    pass++;
  } else {
    known++;
    console.log(`KNOWN ${name}  — ${issue}${detail ? `; ${detail}` : ''}`);
  }
}
/** One group of checks; a crash is reported as a failure and the next group still runs. */
export async function section(title, fn) {
  console.log(`\n# ${title}`);
  try {
    await fn();
  } catch (err) {
    check(`${title}: stopped by an error`, false, String(err?.stack ?? err).split('\n').slice(0, 3).join(' | '));
  }
}
export function summary() {
  console.log(`\n${pass} passed, ${fail} failed, ${known} known issues`);
  return fail;
}

export async function call(method, path, { token, body, form, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let b;
  if (form) b = form;
  else if (body !== undefined) {
    h['Content-Type'] = 'application/json';
    b = JSON.stringify(body);
  }
  const res = await fetch(BASE + path, { method, headers: h, body: b });
  let json = null;
  try {
    json = await res.json();
  } catch {}
  return { status: res.status, json, data: json?.data };
}

export async function ensureAdmin() {
  const email = 'admin@e2e.local';
  await prisma.user.upsert({
    where: { email },
    create: { email, password: await bcrypt.hash('admin1234', 10), role: 'ADMIN' },
    update: {},
  });
  const r = await call('POST', '/auth/login', { body: { email, password: 'admin1234' } });
  if (r.status !== 200) throw new Error(`admin login failed: ${r.status}`);
  return r.data.token;
}

/** A tiny JPEG-typed payload; the API checks type and size only. */
export function jpeg() {
  return new Blob([Buffer.from('ffd8ffe000104a46494600010100000100010000ffd9', 'hex')], { type: 'image/jpeg' });
}

const wibYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' });
/** An instant on the WIB calendar day `daysFromToday` away, at HH:MM WIB. */
export function wibIso(daysFromToday, hhmm = '09:00') {
  const [y, m, d] = wibYmd.format(new Date()).split('-').map(Number);
  // Calendar arithmetic on the WIB date (UTC fields used only as a calendar).
  const day = new Date(Date.UTC(y, m - 1, d + daysFromToday));
  const ymd = [day.getUTCFullYear(), String(day.getUTCMonth() + 1).padStart(2, '0'), String(day.getUTCDate()).padStart(2, '0')].join('-');
  return new Date(`${ymd}T${hhmm}:00+07:00`).toISOString();
}

export const uuid = () => crypto.randomUUID();
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Every push the API sent (recorded by mock-services.mjs). */
export async function pushes() {
  return (await fetch(MOCK + '/__pushes')).json();
}
