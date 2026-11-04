import { getStore } from '@netlify/blobs';
import { makeApi } from '../lib/core.mjs';

const GAS_URL = 'https://script.google.com/macros/s/AKfycbz1G7-KxBwcFTU6xXw3P-AktN3Td8nRk2aLLdl9JWFR35gJHAaSY-uKV4aubE1TzEJL/exec';
const env = (k) => (globalThis.Netlify && Netlify.env && Netlify.env.get(k)) || process.env[k] || '';

export default async (req) => {
  const headers = { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' };
  if (req.method !== 'POST') return new Response(JSON.stringify({ error: 'method' }), { status: 405, headers });
  let out;
  try {
    const b = JSON.parse((await req.text()) || '{}');
    const api = makeApi({ store: getStore({ name: 'zubair', consistency: 'strong' }), env, fetchFn: fetch, gasUrl: GAS_URL });
    out = await api(b.pw, b.op, b.arg);
  } catch (e) {
    out = { __err: String((e && e.message) || e) };
  }
  return new Response(JSON.stringify(out), { status: 200, headers });
};

export const config = { path: '/api' };
