/* =============================================================================
   POST /api/enquiry
   -----------------------------------------------------------------------------
   Receives an enquiry from the landing page, validates it, scores it, and
   forwards it to whatever is configured to receive leads (CRM, Zapier, Make,
   HighLevel, an internal endpoint — anything that accepts a JSON webhook).

   Environment variables (all optional — with none set the endpoint still
   validates and answers, and writes the lead to the function log):

     LEAD_WEBHOOK_URL        Primary destination. JSON POST.
     LEAD_WEBHOOK_URL_2      Optional second destination, posted in parallel.
     LEAD_WEBHOOK_SECRET     If set, each delivery is signed (see below).
     SLACK_WEBHOOK_URL       Optional Slack Incoming Webhook for a lead alert.
     LEAD_VALUE_FLOOR        Lowest pension band treated as qualified.
                             One of UNDER_100K | 100K_250K | 250K_500K |
                             500K_1M | OVER_1M. Default: UNDER_100K.
     THANK_YOU_PATH          Redirect target for non-JS form posts.
                             Default: /thank-you/

   Signing: when LEAD_WEBHOOK_SECRET is set, every delivery carries

     X-LB-Timestamp: <unix seconds>
     X-LB-Signature: sha256=<hex HMAC of `${timestamp}.${rawBody}`>

   Verify by recomputing the HMAC with the same secret and comparing in
   constant time, rejecting timestamps more than five minutes old.
   ============================================================================= */

import { createHmac, randomUUID } from 'node:crypto';

export const config = {
  path: '/api/enquiry'
};

/* ------------------------------------------------------------------ schema */

const ANSWERS = {
  situation: ['ACTIVE', 'IN_TRANSACTION', 'PREPARING', 'EXPLORING', 'LANDLORD'],
  pension_value: ['UNDER_100K', '100K_250K', '250K_500K', '500K_1M', 'OVER_1M', 'NOT_SURE'],
  goal: ['INCOME', 'LEGACY', 'IHT', 'CONSOLIDATE', 'OTHER'],
  age_band: ['UNDER_55', '55_64', '65_74', '75_PLUS']
};

const CALL_TIMES = ['Morning', 'Afternoon', 'Evening'];

/* Ascending order of pension bands, used for the qualification floor. */
const VALUE_ORDER = ['UNDER_100K', '100K_250K', '250K_500K', '500K_1M', 'OVER_1M'];

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const POSTCODE_RE = /^[A-Za-z]{1,2}[0-9][A-Za-z0-9]?\s*[0-9][A-Za-z]{2}$/;
const URL_RE = /(https?:\/\/|www\.)/i;

const MIN_FILL_MS = 2500;
const MAX_FILL_MS = 1000 * 60 * 60 * 6;

/* Best-effort per-instance throttle. Netlify may run several instances, so
   this trims obvious floods rather than enforcing a hard global limit. */
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_MAX = 6;
const recentByIp = new Map();

/* ------------------------------------------------------------------ helpers */

function clean(value, max = 200) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
}

function titleCase(value) {
  return value.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function normalisePhone(raw) {
  const digits = raw.replace(/[^0-9+]/g, '');
  if (digits.startsWith('+')) return '+' + digits.slice(1).replace(/\D/g, '');
  if (digits.startsWith('0')) return '+44' + digits.slice(1);
  return digits;
}

function rateLimited(ip) {
  if (!ip) return false;
  const now = Date.now();
  const hits = (recentByIp.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  hits.push(now);
  recentByIp.set(ip, hits);

  /* Keep the map from growing without bound on a long-lived instance. */
  if (recentByIp.size > 500) {
    for (const [key, times] of recentByIp) {
      if (!times.some((t) => now - t < RATE_WINDOW_MS)) recentByIp.delete(key);
    }
  }
  return hits.length > RATE_MAX;
}

/* Netlify sends geo as a base64 JSON header. Useful for routing an enquiry
   to the nearest office, and harmless when absent. */
function readGeo(request) {
  const raw = request.headers.get('x-nf-geo');
  if (!raw) return {};
  try {
    const geo = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    return {
      city: clean(geo.city || '', 80),
      region: clean(geo.subdivision?.name || '', 80),
      country: clean(geo.country?.code || '', 8)
    };
  } catch {
    return {};
  }
}

async function readBody(request) {
  const type = (request.headers.get('content-type') || '').toLowerCase();

  if (type.includes('application/json')) {
    try {
      const parsed = await request.json();
      return { data: parsed && typeof parsed === 'object' ? parsed : {}, wantsJson: true };
    } catch {
      return { data: {}, wantsJson: true };
    }
  }

  if (type.includes('form')) {
    const form = await request.formData();
    const data = {};
    for (const [key, value] of form.entries()) {
      data[key] = typeof value === 'string' ? value : '';
    }
    return { data, wantsJson: false };
  }

  return { data: {}, wantsJson: true };
}

/* ---------------------------------------------------------------- scoring */

function scoreLead({ situation, pension_value: value, age_band: age }) {
  const floor = (process.env.LEAD_VALUE_FLOOR || 'UNDER_100K').toUpperCase();
  const floorIndex = Math.max(VALUE_ORDER.indexOf(floor), 0);
  const valueIndex = VALUE_ORDER.indexOf(value);

  /* NOT_SURE never disqualifies — plenty of good enquiries don't know yet. */
  const qualified = value === 'NOT_SURE' ? true : valueIndex >= floorIndex;

  const urgent = situation === 'ACTIVE' || situation === 'IN_TRANSACTION';
  const sizeable = valueIndex >= VALUE_ORDER.indexOf('250K_500K');
  const retired = age === '65_74' || age === '75_PLUS';

  let tier = 'C';
  if (qualified && urgent && sizeable) tier = 'A';
  else if (qualified && (urgent || sizeable || (retired && situation === 'LANDLORD'))) tier = 'B';
  else if (qualified) tier = 'C';
  else tier = 'D';

  return { tier, qualified, urgent };
}

/* -------------------------------------------------------------- validation */

function validate(data) {
  const errors = [];
  const lead = {};

  for (const [field, allowed] of Object.entries(ANSWERS)) {
    const value = clean(data[field], 40).toUpperCase();
    if (!allowed.includes(value)) {
      errors.push({ field, message: 'Please choose one of the options.' });
    } else {
      lead[field] = value;
    }
  }

  const firstName = clean(data.first_name, 80);
  if (!firstName) errors.push({ field: 'first_name', message: 'Please tell us your first name.' });
  else if (URL_RE.test(firstName)) errors.push({ field: 'first_name', message: 'Please enter a name.' });
  else lead.first_name = titleCase(firstName);

  const phoneRaw = clean(data.phone, 24);
  if (phoneRaw.replace(/[^0-9]/g, '').length < 10) {
    errors.push({ field: 'phone', message: 'Please enter a phone number we can reach you on.' });
  } else {
    lead.phone = phoneRaw;
    lead.phone_e164 = normalisePhone(phoneRaw);
  }

  const email = clean(data.email, 160).toLowerCase();
  if (!EMAIL_RE.test(email)) errors.push({ field: 'email', message: 'Please enter a valid email address.' });
  else lead.email = email;

  const postcode = clean(data.postcode, 10).toUpperCase();
  if (!POSTCODE_RE.test(postcode)) {
    errors.push({ field: 'postcode', message: 'Please enter a valid UK postcode.' });
  } else {
    /* Normalise to the standard "OUT IN" spacing. */
    const compact = postcode.replace(/\s+/g, '');
    lead.postcode = compact.slice(0, compact.length - 3) + ' ' + compact.slice(-3);
  }

  const callTime = clean(data.call_time, 20);
  lead.call_time = CALL_TIMES.includes(callTime) ? callTime : '';

  const consent = data.consent === true || data.consent === 'yes' || data.consent === 'on' || data.consent === 'true';
  if (!consent) errors.push({ field: 'consent', message: 'Please tick the box so we can contact you.' });
  lead.consent = consent;

  return { lead, errors };
}

function spamCheck(data, ip) {
  if (clean(data.company_website, 120)) return 'honeypot';

  const loadedAt = Number(data.form_loaded_at);
  if (Number.isFinite(loadedAt) && loadedAt > 0) {
    const elapsed = Date.now() - loadedAt;
    if (elapsed < MIN_FILL_MS) return 'too_fast';
    if (elapsed > MAX_FILL_MS) return 'stale';
  }

  if (rateLimited(ip)) return 'rate_limited';
  return null;
}

/* ---------------------------------------------------------------- delivery */

function sign(body) {
  const secret = process.env.LEAD_WEBHOOK_SECRET;
  if (!secret) return {};
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const digest = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return {
    'X-LB-Timestamp': timestamp,
    'X-LB-Signature': `sha256=${digest}`
  };
}

async function postOnce(url, body, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'LesterBruntEnquiry/1.0', ...headers },
      body,
      signal: controller.signal
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error.name === 'AbortError' ? 'timeout' : error.message };
  } finally {
    clearTimeout(timer);
  }
}

/* Two attempts, so a single blip does not lose a lead, while staying well
   inside the function's execution window. */
async function deliver(url, body, headers) {
  let last = await postOnce(url, body, headers, 5000);
  if (last.ok) return last;
  await new Promise((resolve) => setTimeout(resolve, 600));
  last = await postOnce(url, body, headers, 3500);
  return last;
}

async function notifySlack(record) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return;
  const lines = [
    `*New pension enquiry · tier ${record.score.tier}${record.score.urgent ? ' · urgent' : ''}*`,
    `${record.lead.first_name} · ${record.lead.phone} · ${record.lead.email}`,
    `${record.lead.postcode}${record.lead.call_time ? ` · prefers ${record.lead.call_time.toLowerCase()}` : ''}`,
    `Situation: ${record.lead.situation} · Pensions: ${record.lead.pension_value} · Goal: ${record.lead.goal} · Age: ${record.lead.age_band}`,
    `Source: ${record.tracking.utm_source || record.tracking.referrer || 'direct'} · Lead ${record.lead_id}`
  ];
  await postOnce(url, JSON.stringify({ text: lines.join('\n') }), {}, 3000);
}

/* ------------------------------------------------------------------ routes */

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    }
  });
}

function redirect(path, status = 303) {
  return new Response(null, { status, headers: { Location: path, 'Cache-Control': 'no-store' } });
}

export default async function handler(request, context) {
  if (request.method === 'GET') {
    return json({
      ok: true,
      endpoint: 'enquiry',
      accepts: 'POST application/json or application/x-www-form-urlencoded',
      forwarding: Boolean(process.env.LEAD_WEBHOOK_URL),
      signed: Boolean(process.env.LEAD_WEBHOOK_SECRET),
      slack_alerts: Boolean(process.env.SLACK_WEBHOOK_URL)
    });
  }

  if (request.method !== 'POST') {
    return json({ ok: false, message: 'Method not allowed.' }, 405);
  }

  const thankYou = process.env.THANK_YOU_PATH || '/thank-you/';
  const { data, wantsJson } = await readBody(request);
  const ip = request.headers.get('x-nf-client-connection-ip') || context?.ip || '';

  /* Quietly accept spam so bots get no signal about what was rejected. */
  const spam = spamCheck(data, ip);
  if (spam) {
    console.warn(JSON.stringify({ event: 'enquiry_rejected', reason: spam, ip }));
    return wantsJson ? json({ ok: true, lead_id: null, delivery: 'skipped' }) : redirect(thankYou);
  }

  const { lead, errors } = validate(data);
  if (errors.length) {
    if (!wantsJson) return redirect('/?error=validation#enquiry-form');
    return json({ ok: false, message: 'Please check the highlighted fields.', errors }, 400);
  }

  let tracking = {};
  if (data.tracking && typeof data.tracking === 'object') tracking = data.tracking;
  else if (typeof data.tracking === 'string' && data.tracking) {
    try { tracking = JSON.parse(data.tracking); } catch { tracking = {}; }
  }

  const record = {
    lead_id: randomUUID(),
    received_at: new Date().toISOString(),
    source: 'lester-brunt-pensions-lp',
    page_variant: clean(data.page_variant, 40) || 'pensions-c',
    lead,
    score: scoreLead(lead),
    tracking: {
      utm_source: clean(tracking.utm_source, 120),
      utm_medium: clean(tracking.utm_medium, 120),
      utm_campaign: clean(tracking.utm_campaign, 160),
      utm_term: clean(tracking.utm_term, 160),
      utm_content: clean(tracking.utm_content, 160),
      gclid: clean(tracking.gclid, 255),
      gbraid: clean(tracking.gbraid, 255),
      wbraid: clean(tracking.wbraid, 255),
      fbclid: clean(tracking.fbclid, 255),
      msclkid: clean(tracking.msclkid, 255),
      ga_client_id: clean(tracking.ga_client_id, 64),
      landing_path: clean(tracking.landing_path, 255),
      referrer: clean(tracking.referrer, 255)
    },
    meta: {
      ip,
      ...readGeo(request),
      user_agent: clean(request.headers.get('user-agent') || '', 255)
    }
  };

  const body = JSON.stringify(record);
  const headers = sign(body);

  const targets = [process.env.LEAD_WEBHOOK_URL, process.env.LEAD_WEBHOOK_URL_2].filter(Boolean);
  let delivery = 'not_configured';

  if (targets.length) {
    const results = await Promise.all(targets.map((url) => deliver(url, body, headers)));
    delivery = results.every((r) => r.ok) ? 'delivered' : results.some((r) => r.ok) ? 'partial' : 'failed';
    results.forEach((result, index) => {
      if (!result.ok) {
        console.error(JSON.stringify({
          event: 'enquiry_delivery_failed',
          lead_id: record.lead_id,
          target: index + 1,
          status: result.status,
          error: result.error || null
        }));
      }
    });
  }

  /* The full record goes to the function log either way, so a lead is
     recoverable from Netlify even if every webhook is down. */
  console.log('LEAD_RECORD ' + JSON.stringify({ ...record, delivery }));

  try {
    await notifySlack(record);
  } catch (error) {
    console.error(JSON.stringify({ event: 'slack_notify_failed', message: error.message }));
  }

  if (!wantsJson) return redirect(thankYou);

  return json({
    ok: true,
    lead_id: record.lead_id,
    tier: record.score.tier,
    delivery,
    redirect: thankYou
  });
}
