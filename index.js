const express = require('express');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const SPREADSHEET_ID = process.env.GOOGLE_SHEET_ID || '1Fzjz9uT5Mus0sVNUPGNurUaZIbCXGNdklkz8DTOAeVA';
const RECORDS_SHEET = process.env.GOOGLE_RECORDS_SHEET || 'CRM Records';
const PRODUCTS_SHEET = process.env.GOOGLE_PRODUCTS_SHEET || 'Product List';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;
const HEADERS = ['ID', 'Date', 'Description', 'Price', 'Customer Name', 'Address', 'License Number', 'Note', 'Updated At'];

app.disable('x-powered-by');
app.use(express.json({ limit: '100kb' }));

function credentials() {
  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      const parsed = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
      return { email: parsed.client_email, key: parsed.private_key };
    }
  } catch (_) {}
  return {
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: process.env.GOOGLE_PRIVATE_KEY && process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n')
  };
}

let tokenCache = { value: '', expires: 0 };
function b64url(value) {
  return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

async function accessToken() {
  if (tokenCache.value && Date.now() < tokenCache.expires - 60000) return tokenCache.value;
  const creds = credentials();
  if (!creds.email || !creds.key) return '';
  const now = Math.floor(Date.now() / 1000);
  const unsigned = `${b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${b64url(JSON.stringify({
    iss: creds.email,
    scope: 'https://www.googleapis.com/auth/spreadsheets',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  }))}`;
  const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), creds.key);
  const assertion = `${unsigned}.${b64url(signature)}`;
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error_description || 'Google authentication failed.');
  tokenCache = { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 };
  return tokenCache.value;
}

async function google(path, options = {}) {
  const token = await accessToken();
  if (!token) throw Object.assign(new Error('Google Sheets write access is not configured.'), { status: 503, setup: true });
  const response = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`, {
    ...options,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || 'Google Sheets request failed.');
  return body;
}

function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell.replace(/\r$/, '')); rows.push(row); }
  return rows;
}

async function publicSheet(sheet) {
  const url = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(sheet)}&_=${Date.now()}`;
  const response = await fetch(url, { headers: { 'user-agent': 'X17-Technologies-CRM/1.0' } });
  if (!response.ok) throw new Error(`Unable to read ${sheet}.`);
  return parseCsv(await response.text());
}

function rowToRecord(row) {
  return {
    id: String(row[0] || ''), date: String(row[1] || ''), description: String(row[2] || ''),
    price: Number(String(row[3] || '0').replace(/[^0-9.-]/g, '')) || 0,
    customerName: String(row[4] || ''), address: String(row[5] || ''),
    licenseNumber: String(row[6] || ''), note: String(row[7] || ''), updatedAt: String(row[8] || '')
  };
}

async function getValues(sheet) {
  const token = await accessToken();
  if (token) {
    try {
      const data = await google(`/values/${encodeURIComponent(`'${sheet}'!A:Z`)}`);
      return data.values || [];
    } catch (error) {
      if (!String(error.message).toLowerCase().includes('unable to parse range')) throw error;
      return [];
    }
  }
  return publicSheet(sheet);
}

async function ensureRecordsSheet() {
  const meta = await google('?fields=sheets.properties');
  let target = (meta.sheets || []).find(s => s.properties.title === RECORDS_SHEET);
  if (!target) {
    const created = await google(':batchUpdate', {
      method: 'POST', body: JSON.stringify({ requests: [{ addSheet: { properties: { title: RECORDS_SHEET, frozenRowCount: 1 } } }] })
    });
    target = { properties: created.replies[0].addSheet.properties };
  }
  const values = await google(`/values/${encodeURIComponent(`'${RECORDS_SHEET}'!A1:I1`)}`);
  if (!values.values?.length) {
    await google(`/values/${encodeURIComponent(`'${RECORDS_SHEET}'!A1:I1`)}?valueInputOption=RAW`, {
      method: 'PUT', body: JSON.stringify({ values: [HEADERS] })
    });
  }
  return target.properties.sheetId;
}

function cleanRecord(body) {
  const value = {
    date: String(body.date || '').trim(), description: String(body.description || '').trim(),
    price: Number(body.price), customerName: String(body.customerName || '').trim(),
    address: String(body.address || '').trim(), licenseNumber: String(body.licenseNumber || '').trim(),
    note: String(body.note || '').trim()
  };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw Object.assign(new Error('Enter a valid date.'), { status: 400 });
  if (!value.description || !value.customerName) throw Object.assign(new Error('Product and customer name are required.'), { status: 400 });
  if (!Number.isFinite(value.price) || value.price < 0) throw Object.assign(new Error('Enter a valid price.'), { status: 400 });
  return value;
}

app.get('/api/config', (_req, res) => res.json({ sheetUrl: SHEET_URL, connected: Boolean(credentials().email && credentials().key), recordsSheet: RECORDS_SHEET }));

app.get('/api/products', async (_req, res) => {
  try {
    const rows = await getValues(PRODUCTS_SHEET);
    const products = [...new Set(rows.flat().map(String).map(v => v.trim()).filter(v => v && !/^products?$/i.test(v)))];
    res.json({ products });
  } catch (error) { res.status(502).json({ error: error.message }); }
});

app.get('/api/records', async (_req, res) => {
  try {
    const rows = await getValues(RECORDS_SHEET);
    const records = rows.slice(1).map(rowToRecord).filter(r => r.id || r.customerName || r.description);
    res.json({ records, connected: Boolean(await accessToken()) });
  } catch (error) {
    if (!await accessToken().catch(() => '')) return res.json({ records: [], connected: false });
    res.status(502).json({ error: error.message });
  }
});

app.post('/api/records', async (req, res) => {
  try {
    const value = cleanRecord(req.body);
    await ensureRecordsSheet();
    const record = { id: crypto.randomUUID(), ...value, updatedAt: new Date().toISOString() };
    await google(`/values/${encodeURIComponent(`'${RECORDS_SHEET}'!A:I`)}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST', body: JSON.stringify({ values: [[record.id, record.date, record.description, record.price, record.customerName, record.address, record.licenseNumber, record.note, record.updatedAt]] })
    });
    res.status(201).json({ record });
  } catch (error) { res.status(error.status || 500).json({ error: error.message, setup: Boolean(error.setup) }); }
});

app.put('/api/records/:id', async (req, res) => {
  try {
    const value = cleanRecord(req.body);
    const rows = await getValues(RECORDS_SHEET);
    const index = rows.findIndex((row, i) => i > 0 && String(row[0]) === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Record not found.' });
    const record = { id: req.params.id, ...value, updatedAt: new Date().toISOString() };
    const rowNumber = index + 1;
    await google(`/values/${encodeURIComponent(`'${RECORDS_SHEET}'!A${rowNumber}:I${rowNumber}`)}?valueInputOption=USER_ENTERED`, {
      method: 'PUT', body: JSON.stringify({ values: [[record.id, record.date, record.description, record.price, record.customerName, record.address, record.licenseNumber, record.note, record.updatedAt]] })
    });
    res.json({ record });
  } catch (error) { res.status(error.status || 500).json({ error: error.message, setup: Boolean(error.setup) }); }
});

app.delete('/api/records/:id', async (req, res) => {
  try {
    const rows = await getValues(RECORDS_SHEET);
    const index = rows.findIndex((row, i) => i > 0 && String(row[0]) === req.params.id);
    if (index < 0) return res.status(404).json({ error: 'Record not found.' });
    const sheetId = await ensureRecordsSheet();
    await google(':batchUpdate', { method: 'POST', body: JSON.stringify({ requests: [{ deleteDimension: { range: { sheetId, dimension: 'ROWS', startIndex: index, endIndex: index + 1 } } }] }) });
    res.status(204).end();
  } catch (error) { res.status(error.status || 500).json({ error: error.message, setup: Boolean(error.setup) }); }
});

const page = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#071426"><meta name="description" content="X-17 Technologies customer relationship management and sales intelligence dashboard.">
<title>X-17 Technologies CRM</title>
<style>
:root{--bg:#06111f;--panel:#0b1b2f;--panel2:#0e2540;--line:#173a5d;--text:#e8f4ff;--muted:#82a4c4;--blue:#35b8ff;--cyan:#77e3ff;--green:#2fe0a4;--red:#ff667d;--amber:#ffca67;--shadow:0 20px 60px #02091388;--radius:18px}
*{box-sizing:border-box}html{color-scheme:dark;scroll-behavior:smooth}body{margin:0;min-width:320px;background:radial-gradient(circle at 82% -10%,#103b68 0,transparent 31%),linear-gradient(135deg,#06111f,#081727 55%,#05101d);color:var(--text);font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;min-height:100vh}button,input,select,textarea{font:inherit}button,a{touch-action:manipulation}.shell{max-width:1480px;margin:auto;padding:22px 28px 48px}.topbar{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:28px}.brand{display:flex;align-items:center;gap:13px}.logo{width:46px;height:46px;border:1px solid #3bc4ff66;border-radius:14px;background:linear-gradient(145deg,#113e67,#07192d);display:grid;place-items:center;font-weight:900;font-size:19px;letter-spacing:-1px;color:var(--cyan);box-shadow:0 0 28px #21b7ff30,inset 0 0 20px #4ad5ff16}.brand h1{font-size:18px;letter-spacing:.2px;margin:0}.brand p{margin:2px 0 0;color:var(--muted);font-size:12px}.top-actions{display:flex;align-items:center;gap:10px}.status{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.dot{width:8px;height:8px;border-radius:50%;background:var(--amber);box-shadow:0 0 12px currentColor}.dot.live{background:var(--green)}.btn{border:1px solid var(--line);background:#0b2037;color:var(--text);border-radius:11px;padding:10px 14px;display:inline-flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;text-decoration:none;font-weight:700;transition:.18s}.btn:hover{transform:translateY(-1px);border-color:#3ebfff88;background:#0e2946}.btn.primary{border-color:#54caff77;background:linear-gradient(135deg,#168bd0,#36b8f5);color:#041321;box-shadow:0 8px 24px #168bd033}.btn.danger{color:#ff9aaa}.btn:disabled{opacity:.45;cursor:not-allowed;transform:none}.hero{display:grid;grid-template-columns:1.7fr 1fr;gap:18px;margin-bottom:18px}.hero-main,.sync-card,.metric,.panel{border:1px solid var(--line);background:linear-gradient(145deg,#0c2036e8,#081727e8);border-radius:var(--radius);box-shadow:var(--shadow);position:relative;overflow:hidden}.hero-main{padding:30px 32px}.hero-main:after{content:"";position:absolute;width:220px;height:220px;border:1px solid #3fc6ff17;border-radius:50%;right:-50px;top:-85px;box-shadow:0 0 0 30px #3fc6ff08,0 0 0 60px #3fc6ff05}.eyebrow{color:var(--cyan);text-transform:uppercase;letter-spacing:2.2px;font-size:10px;font-weight:800}.hero h2{font-size:clamp(25px,3vw,40px);line-height:1.08;letter-spacing:-1.2px;margin:9px 0 10px;max-width:720px}.hero-main p{color:var(--muted);font-size:15px;max-width:650px;margin:0}.sync-card{padding:24px}.sync-head{display:flex;justify-content:space-between;gap:12px}.sync-orb{width:50px;height:50px;border-radius:50%;background:radial-gradient(circle,#7de6ff,#1795d9 45%,#0b2841 48%);box-shadow:0 0 28px #35b8ff66;position:relative}.sync-orb:after{content:"";position:absolute;inset:-8px;border:1px dashed #46c8ff88;border-radius:50%;animation:spin 12s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.sync-card strong{font-size:18px}.sync-card p{color:var(--muted);margin:5px 0 18px}.sync-meta{border-top:1px solid var(--line);padding-top:14px;display:flex;justify-content:space-between;color:var(--muted);font-size:12px}.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:18px}.metric{padding:20px}.metric-top{display:flex;align-items:center;justify-content:space-between;color:var(--muted);font-size:12px}.metric-icon{width:34px;height:34px;border:1px solid var(--line);border-radius:10px;display:grid;place-items:center;color:var(--cyan);background:#102941}.metric-value{font-size:27px;font-weight:800;letter-spacing:-.8px;margin-top:12px}.metric-foot{font-size:11px;color:var(--muted);margin-top:5px}.positive{color:var(--green)}.workspace{display:grid;grid-template-columns:380px minmax(0,1fr);gap:18px}.panel-title{display:flex;align-items:center;justify-content:space-between;padding:20px 22px;border-bottom:1px solid var(--line)}.panel-title h3{margin:0;font-size:15px}.panel-title span{font-size:11px;color:var(--muted)}.form-body{padding:20px}.field{margin-bottom:14px}.field label{display:block;color:#a9c4dc;font-size:11px;font-weight:700;letter-spacing:.35px;margin-bottom:7px}.req{color:var(--cyan)}input,select,textarea{width:100%;border:1px solid #1b4165;background:#07182a;color:var(--text);border-radius:10px;padding:11px 12px;outline:none;transition:.18s}input:focus,select:focus,textarea:focus{border-color:var(--blue);box-shadow:0 0 0 3px #35b8ff18}textarea{min-height:76px;resize:vertical}.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}.form-actions{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:19px}.form-actions .primary{grid-column:1/-1}.editing{display:none;margin-bottom:15px;padding:10px 12px;border:1px solid #35b8ff55;background:#123a5d88;border-radius:10px;color:#afe9ff;font-size:12px}.editing.show{display:flex;align-items:center;justify-content:space-between}.analytics{display:grid;grid-template-columns:1.35fr .65fr;gap:14px;margin-bottom:14px}.chart{padding:18px 20px;min-height:225px}.chart-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:15px}.chart-head h3{font-size:14px;margin:0}.chart-head p{font-size:11px;color:var(--muted);margin:3px 0 0}.chart canvas{width:100%;height:145px;display:block}.donut-wrap{height:155px;position:relative;display:grid;place-items:center}.donut-wrap canvas{position:absolute;inset:0;width:100%;height:100%}.donut-center{text-align:center;pointer-events:none}.donut-center b{font-size:22px}.donut-center small{display:block;color:var(--muted)}.table-panel{min-width:0}.toolbar{padding:14px 18px;display:flex;gap:10px;border-bottom:1px solid var(--line);align-items:center}.search{position:relative;flex:1}.search:before{content:"⌕";position:absolute;left:12px;top:7px;font-size:20px;color:var(--muted)}.search input{padding-left:38px}.toolbar select{width:auto;min-width:160px}.table-scroll{overflow:auto;max-height:510px}table{width:100%;border-collapse:collapse;min-width:900px}th{position:sticky;top:0;z-index:2;background:#0c2137;color:#7899b8;font-size:10px;text-transform:uppercase;letter-spacing:.6px;text-align:left;padding:12px 14px;border-bottom:1px solid var(--line)}td{padding:13px 14px;border-bottom:1px solid #14324e;color:#cde0f2;vertical-align:middle}tr:hover td{background:#0c2135}.customer strong{display:block;color:#f0f8ff}.customer small{color:var(--muted)}.product-tag{display:inline-block;max-width:250px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.money{font-weight:800;color:#a5f2ff;white-space:nowrap}.row-actions{display:flex;gap:5px}.icon-btn{width:32px;height:32px;border:1px solid var(--line);background:#0b2138;color:#91b7d7;border-radius:9px;cursor:pointer}.icon-btn:hover{color:white;border-color:var(--blue)}.icon-btn.delete:hover{color:#ff8ba0;border-color:#ff667d66}.empty{display:none;padding:54px 20px;text-align:center;color:var(--muted)}.empty.show{display:block}.empty-icon{font-size:34px;color:var(--blue);margin-bottom:8px}.toast{position:fixed;right:22px;bottom:22px;max-width:360px;padding:13px 16px;background:#102a45;border:1px solid #2d6490;border-radius:12px;box-shadow:var(--shadow);transform:translateY(25px);opacity:0;pointer-events:none;transition:.25s;z-index:20}.toast.show{opacity:1;transform:none}.toast.error{border-color:#a83e55;background:#371825}.skeleton{height:14px;border-radius:6px;background:linear-gradient(90deg,#102740,#183a5b,#102740);background-size:200%;animation:shimmer 1.2s infinite}@keyframes shimmer{to{background-position:-200%}}
@media(max-width:1050px){.workspace{grid-template-columns:330px minmax(0,1fr)}.analytics{grid-template-columns:1fr}.metrics{grid-template-columns:1fr 1fr}}
@media(max-width:800px){.shell{padding:16px 14px 38px}.topbar{align-items:flex-start}.brand p,.status span{display:none}.top-actions .sheet-label{display:none}.hero{grid-template-columns:1fr}.hero-main{padding:24px}.metrics{grid-template-columns:1fr 1fr}.workspace{grid-template-columns:1fr}.form-panel{order:1}.content{order:2}.toolbar{flex-wrap:wrap}.search{flex-basis:100%}.toolbar select{flex:1;min-width:130px}.table-scroll{max-height:none;overflow:visible}table{min-width:0}thead{display:none}tbody,tr,td{display:block}tr{margin:12px;border:1px solid var(--line);border-radius:13px;overflow:hidden;background:#091b2e}td{display:grid;grid-template-columns:105px 1fr;gap:12px;padding:10px 13px}td:before{content:attr(data-label);color:#6f94b5;font-size:10px;text-transform:uppercase;letter-spacing:.5px}.row-actions{justify-content:flex-start}.product-tag{max-width:none;white-space:normal}.analytics{grid-template-columns:1fr 1fr}.chart{min-height:210px}}
@media(max-width:560px){.logo{width:40px;height:40px}.brand h1{font-size:15px}.top-actions .btn{padding:9px 10px}.hero h2{font-size:27px}.metrics{gap:10px}.metric{padding:16px}.metric-value{font-size:22px}.analytics{grid-template-columns:1fr}.form-grid{grid-template-columns:1fr}.sync-card{display:none}.toolbar select{width:100%}.form-actions{position:sticky;bottom:8px;background:#091a2bea;padding:8px;border:1px solid var(--line);border-radius:13px;z-index:3}}
</style></head>
<body><main class="shell">
<header class="topbar"><div class="brand"><div class="logo">X<span style="color:white">17</span></div><div><h1>X-17 Technologies CRM</h1><p>Sales intelligence command center</p></div></div><div class="top-actions"><div class="status"><i class="dot" id="statusDot"></i><span id="statusText">Checking connection</span></div><a class="btn" id="sheetLink" target="_blank" rel="noopener"><span>↗</span><span class="sheet-label">Open Google Sheet</span></a></div></header>
<section class="hero"><div class="hero-main"><div class="eyebrow">Customer intelligence • Live operations</div><h2>Turn every sale into a smarter customer relationship.</h2><p>Capture customer records, monitor product performance, and keep your team synchronized with one clear, mobile-ready workspace.</p></div><div class="sync-card"><div class="sync-head"><div><div class="eyebrow">Data uplink</div><strong>Google Sheets</strong></div><div class="sync-orb"></div></div><p id="syncCopy">Connecting to your workspace…</p><div class="sync-meta"><span id="syncTime">Not synced yet</span><span id="recordSheet">CRM Records</span></div></div></section>
<section class="metrics"><article class="metric"><div class="metric-top"><span>Total records</span><i class="metric-icon">▦</i></div><div class="metric-value" id="mRecords">0</div><div class="metric-foot"><span class="positive">Live</span> customer database</div></article><article class="metric"><div class="metric-top"><span>Total sales</span><i class="metric-icon">₱</i></div><div class="metric-value" id="mSales">₱0</div><div class="metric-foot">Across visible records</div></article><article class="metric"><div class="metric-top"><span>This month</span><i class="metric-icon">◫</i></div><div class="metric-value" id="mMonth">0</div><div class="metric-foot">New customer entries</div></article><article class="metric"><div class="metric-top"><span>Top product</span><i class="metric-icon">◇</i></div><div class="metric-value" id="mTop" style="font-size:16px;line-height:1.35">—</div><div class="metric-foot">By number of records</div></article></section>
<section class="workspace">
<aside class="panel form-panel"><div class="panel-title"><h3 id="formTitle">Add customer record</h3><span>Secure entry</span></div><form class="form-body" id="recordForm"><div class="editing" id="editingBanner"><span>Editing selected record</span><button type="button" class="icon-btn" id="cancelEdit" aria-label="Cancel edit">×</button></div><div class="form-grid"><div class="field"><label for="date">DATE <span class="req">*</span></label><input id="date" name="date" type="date" required></div><div class="field"><label for="price">PRICE (PHP) <span class="req">*</span></label><input id="price" name="price" type="number" min="0" step="0.01" placeholder="0.00" required></div></div><div class="field"><label for="description">DESCRIPTION / PRODUCT <span class="req">*</span></label><select id="description" name="description" required><option value="">Loading Product List…</option></select></div><div class="field"><label for="customerName">CUSTOMER NAME <span class="req">*</span></label><input id="customerName" name="customerName" autocomplete="name" placeholder="Full name" required></div><div class="field"><label for="address">ADDRESS</label><input id="address" name="address" autocomplete="street-address" placeholder="Complete address"></div><div class="field"><label for="licenseNumber">LICENSE NUMBER</label><input id="licenseNumber" name="licenseNumber" placeholder="e.g. NTC / business license"></div><div class="field"><label for="note">NOTE</label><textarea id="note" name="note" maxlength="1000" placeholder="Add context, follow-up, or special instructions"></textarea></div><div class="form-actions"><button class="btn primary" id="saveBtn" type="submit">＋ Add record</button><button class="btn" id="resetBtn" type="button">Clear</button><button class="btn danger" id="deleteBtn" type="button" disabled>Delete</button></div></form></aside>
<div class="content"><div class="analytics"><article class="panel chart"><div class="chart-head"><div><h3>Sales trajectory</h3><p>Revenue across the last six months</p></div><span class="eyebrow">PHP</span></div><canvas id="barChart" aria-label="Six month sales chart"></canvas></article><article class="panel chart"><div class="chart-head"><div><h3>Product mix</h3><p>Share of filtered records</p></div></div><div class="donut-wrap"><canvas id="donutChart" aria-label="Product mix chart"></canvas><div class="donut-center"><b id="donutValue">0</b><small>products</small></div></div></article></div>
<section class="panel table-panel"><div class="panel-title"><h3>Customer records</h3><span id="resultCount">0 results</span></div><div class="toolbar"><div class="search"><input id="search" type="search" placeholder="Search customer, product, address, license…" aria-label="Search records"></div><select id="productFilter" aria-label="Filter by product"><option value="">All products</option></select><select id="dateFilter" aria-label="Filter by date"><option value="">All dates</option><option value="month">This month</option><option value="30">Last 30 days</option><option value="year">This year</option></select></div><div class="table-scroll"><table><thead><tr><th>Date</th><th>Customer</th><th>Product</th><th>Price</th><th>Address</th><th>License</th><th>Actions</th></tr></thead><tbody id="recordRows"></tbody></table><div class="empty" id="emptyState"><div class="empty-icon">⌁</div><strong>No records found</strong><div>Try changing the filters or add your first customer.</div></div></div></section></div>
</section></main><div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
(function(){
  var records=[],filtered=[],editingId='',products=[],config={};
  var $=function(id){return document.getElementById(id)};
  function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]})}
  function money(v){return new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP',maximumFractionDigits:2}).format(Number(v)||0)}
  function today(){var d=new Date(),off=d.getTimezoneOffset();return new Date(d.getTime()-off*60000).toISOString().slice(0,10)}
  function toast(message,error){var el=$('toast');el.textContent=message;el.className='toast show'+(error?' error':'');clearTimeout(el.timer);el.timer=setTimeout(function(){el.className='toast'},3600)}
  async function api(url,options){var response=await fetch(url,options);var data=response.status===204?{}:await response.json().catch(function(){return {}});if(!response.ok)throw Object.assign(new Error(data.error||'Request failed.'),data);return data}
  function setConnection(live){$('statusDot').className='dot'+(live?' live':'');$('statusText').textContent=live?'Sheets connected':'Read-only mode';$('syncCopy').textContent=live?'Two-way sync is active. Changes save directly to your CRM Records sheet.':'Product List connected. Add Railway credentials to enable secure record changes.'}
  async function loadConfig(){config=await api('/api/config');$('sheetLink').href=config.sheetUrl;$('recordSheet').textContent=config.recordsSheet;setConnection(config.connected)}
  async function loadProducts(){try{var d=await api('/api/products');products=d.products||[];var options='<option value="">Select a product</option>'+products.map(function(p){return '<option value="'+esc(p)+'">'+esc(p)+'</option>'}).join('');$('description').innerHTML=options;$('productFilter').innerHTML='<option value="">All products</option>'+products.map(function(p){return '<option value="'+esc(p)+'">'+esc(p)+'</option>'}).join('')}catch(e){$('description').innerHTML='<option value="">Product List unavailable</option>';toast(e.message,true)}}
  async function loadRecords(){try{var d=await api('/api/records');records=d.records||[];setConnection(d.connected);$('syncTime').textContent='Synced '+new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});render()}catch(e){toast(e.message,true);render()}}
  function matchesDate(record,filter){if(!filter)return true;var d=new Date(record.date+'T00:00:00'),now=new Date();if(filter==='month')return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear();if(filter==='year')return d.getFullYear()===now.getFullYear();if(filter==='30')return (now-d)/86400000<=30&&(now-d)>=0;return true}
  function applyFilters(){var q=$('search').value.toLowerCase().trim(),product=$('productFilter').value,date=$('dateFilter').value;filtered=records.filter(function(r){var blob=[r.customerName,r.description,r.address,r.licenseNumber,r.note,r.date].join(' ').toLowerCase();return (!q||blob.indexOf(q)>-1)&&(!product||r.description===product)&&matchesDate(r,date)})}
  function render(){applyFilters();var rows=$('recordRows');rows.innerHTML=filtered.map(function(r){return '<tr data-id="'+esc(r.id)+'"><td data-label="Date">'+esc(r.date)+'</td><td data-label="Customer" class="customer"><strong>'+esc(r.customerName)+'</strong><small>'+esc(r.note||'No note')+'</small></td><td data-label="Product"><span class="product-tag" title="'+esc(r.description)+'">'+esc(r.description)+'</span></td><td data-label="Price" class="money">'+money(r.price)+'</td><td data-label="Address">'+esc(r.address||'—')+'</td><td data-label="License">'+esc(r.licenseNumber||'—')+'</td><td data-label="Actions"><div class="row-actions"><button class="icon-btn edit" aria-label="Edit '+esc(r.customerName)+'" title="Edit">✎</button><button class="icon-btn delete" aria-label="Delete '+esc(r.customerName)+'" title="Delete">×</button></div></td></tr>'}).join('');$('emptyState').className='empty'+(filtered.length?'':' show');$('resultCount').textContent=filtered.length+' result'+(filtered.length===1?'':'s');rows.querySelectorAll('.edit').forEach(function(b){b.onclick=function(){editRecord(b.closest('tr').dataset.id)}});rows.querySelectorAll('.delete').forEach(function(b){b.onclick=function(){deleteRecord(b.closest('tr').dataset.id)}});updateMetrics();drawCharts()}
  function updateMetrics(){var now=new Date(),month=records.filter(function(r){var d=new Date(r.date+'T00:00:00');return d.getMonth()===now.getMonth()&&d.getFullYear()===now.getFullYear()}).length;var counts={};records.forEach(function(r){counts[r.description]=(counts[r.description]||0)+1});var top=Object.keys(counts).sort(function(a,b){return counts[b]-counts[a]})[0]||'—';$('mRecords').textContent=records.length;$('mSales').textContent=money(filtered.reduce(function(s,r){return s+Number(r.price||0)},0));$('mMonth').textContent=month;$('mTop').textContent=top;$('mTop').title=top}
  function prepareCanvas(id){var c=$(id),box=c.getBoundingClientRect(),dpr=window.devicePixelRatio||1;c.width=Math.max(1,box.width*dpr);c.height=Math.max(1,box.height*dpr);var x=c.getContext('2d');x.scale(dpr,dpr);return {x:x,w:box.width,h:box.height}}
  function drawCharts(){drawBars();drawDonut()}
  function drawBars(){var p=prepareCanvas('barChart'),x=p.x,w=p.w,h=p.h;var months=[],vals=[],now=new Date();for(var i=5;i>=0;i--){var d=new Date(now.getFullYear(),now.getMonth()-i,1);months.push(d.toLocaleString('en',{month:'short'}));vals.push(filtered.filter(function(r){var q=new Date(r.date+'T00:00:00');return q.getMonth()===d.getMonth()&&q.getFullYear()===d.getFullYear()}).reduce(function(s,r){return s+Number(r.price||0)},0))}var max=Math.max.apply(null,vals.concat([1])),pad=18,gap=11,bw=(w-pad*2-gap*5)/6;x.clearRect(0,0,w,h);for(var j=0;j<6;j++){var bh=Math.max(3,(vals[j]/max)*(h-35)),left=pad+j*(bw+gap),top=h-22-bh;var g=x.createLinearGradient(0,top,0,h);g.addColorStop(0,'#66dcff');g.addColorStop(1,'#147fc2');x.fillStyle=g;x.beginPath();if(x.roundRect)x.roundRect(left,top,bw,bh,[5,5,1,1]);else x.rect(left,top,bw,bh);x.fill();x.fillStyle='#7195b4';x.font='10px system-ui';x.textAlign='center';x.fillText(months[j],left+bw/2,h-5)}}
  function drawDonut(){var p=prepareCanvas('donutChart'),x=p.x,w=p.w,h=p.h,counts={};filtered.forEach(function(r){counts[r.description]=(counts[r.description]||0)+1});var vals=Object.values(counts),total=vals.reduce(function(a,b){return a+b},0),colors=['#35b8ff','#2fe0a4','#9a7cff','#ffca67','#ff667d'],start=-Math.PI/2,cx=w/2,cy=h/2,r=Math.min(w,h)*.34;x.clearRect(0,0,w,h);x.lineWidth=13;if(!total){x.strokeStyle='#173a5d';x.beginPath();x.arc(cx,cy,r,0,Math.PI*2);x.stroke()}else vals.slice(0,5).forEach(function(v,i){var end=start+Math.PI*2*v/total;x.strokeStyle=colors[i];x.beginPath();x.arc(cx,cy,r,start+.025,end-.025);x.stroke();start=end});$('donutValue').textContent=Object.keys(counts).length}
  function clearForm(){editingId='';$('recordForm').reset();$('date').value=today();$('editingBanner').className='editing';$('formTitle').textContent='Add customer record';$('saveBtn').textContent='＋ Add record';$('deleteBtn').disabled=true}
  function editRecord(id){var r=records.find(function(v){return v.id===id});if(!r)return;editingId=id;['date','description','price','customerName','address','licenseNumber','note'].forEach(function(k){$(k).value=r[k]==null?'':r[k]});$('editingBanner').className='editing show';$('formTitle').textContent='Edit customer record';$('saveBtn').textContent='✓ Save changes';$('deleteBtn').disabled=false;document.querySelector('.form-panel').scrollIntoView({behavior:'smooth',block:'start'})}
  async function saveRecord(e){e.preventDefault();var body={};new FormData(e.target).forEach(function(v,k){body[k]=v});var button=$('saveBtn'),wasEdit=Boolean(editingId);button.disabled=true;button.textContent=wasEdit?'Saving changes…':'Adding record…';try{await api(wasEdit?'/api/records/'+encodeURIComponent(editingId):'/api/records',{method:wasEdit?'PUT':'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});toast(wasEdit?'Record updated in Google Sheets.':'Record added to Google Sheets.');clearForm();await loadRecords()}catch(err){toast(err.setup?'Write access needs Railway credentials. See the setup note below.':err.message,true)}finally{button.disabled=false;if(!editingId)button.textContent='＋ Add record'}}
  async function deleteRecord(id){var r=records.find(function(v){return v.id===id});if(!r||!confirm('Delete the record for '+r.customerName+'? This also removes it from Google Sheets.'))return;try{await api('/api/records/'+encodeURIComponent(id),{method:'DELETE'});toast('Record deleted from Google Sheets.');if(editingId===id)clearForm();await loadRecords()}catch(err){toast(err.setup?'Write access needs Railway credentials.':err.message,true)}}
  $('recordForm').onsubmit=saveRecord;$('resetBtn').onclick=clearForm;$('cancelEdit').onclick=clearForm;$('deleteBtn').onclick=function(){if(editingId)deleteRecord(editingId)};['search','productFilter','dateFilter'].forEach(function(id){$(id).addEventListener(id==='search'?'input':'change',render)});var resizeTimer;window.addEventListener('resize',function(){clearTimeout(resizeTimer);resizeTimer=setTimeout(drawCharts,120)});$('date').value=today();Promise.all([loadConfig(),loadProducts()]).then(loadRecords).catch(function(e){toast(e.message,true);loadRecords()});
})();
</script></body></html>`;

app.get('/health', (_req, res) => res.json({ ok: true, app: 'X-17 Technologies CRM' }));
app.use((_req, res) => res.type('html').send(page));

app.listen(PORT, '0.0.0.0', () => console.log(`X-17 Technologies CRM running on http://localhost:${PORT}`));
