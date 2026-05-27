const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fetch = require('node-fetch');
const FormData = require('form-data');
const path = require('path');
const fs = require('fs');
const config = require('./config');

const app = express();
const upload = multer({ dest: '/tmp/sakigake-uploads/', limits: { fileSize: 20 * 1024 * 1024 } });

app.use(cors());
app.use(express.json());

// ngrok free tier 対応: Service Worker + ヘッダー注入
const NGROK_INJECT = `
<script>
// ngrok free tier バイパス: Service Worker で全リクエストにヘッダー追加
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw-ngrok.js', { scope: '/' })
    .then(() => console.log('[SAKIGAKE] ngrok SW registered'))
    .catch(e => console.warn('[SAKIGAKE] SW failed:', e));
}
// fetch にもヘッダー追加 (SW登録前のフォールバック)
(function(){
  const _f = window.fetch;
  window.fetch = function(u, o) {
    o = o || {};
    o.headers = new Headers(o.headers || {});
    o.headers.set('ngrok-skip-browser-warning', 'true');
    return _f.call(this, u, o);
  };
})();
</script>`;

const AUTH_INJECT = `<script src="/auth.js"></script>`;

// login.html は認証チェックをスキップ
const LOGIN_PAGES = ['login.html', 'index.html', 'sakigake-agent.html'];

function serveHtmlWithInject(filePath, res) {
  let html = fs.readFileSync(filePath, 'utf-8');
  const fileName = path.basename(filePath);
  const skipAuth = LOGIN_PAGES.includes(fileName);
  const inject = skipAuth ? NGROK_INJECT : NGROK_INJECT + AUTH_INJECT;
  html = html.replace(/<head>/i, '<head>' + inject);
  res.type('html').send(html);
}

// HTML ページ配信 (ngrok対応コード注入)
app.get('/', (req, res) => {
  serveHtmlWithInject(path.join(__dirname, 'index.html'), res);
});
app.get('*.html', (req, res, next) => {
  const filePath = path.join(__dirname, req.path);
  if (!fs.existsSync(filePath)) return next();
  serveHtmlWithInject(filePath, res);
});

// 静的ファイル配信（JS/CSS/画像など）
app.use(express.static(path.join(__dirname)));

// 営業管理ダッシュボードのルート
app.get('/admin', (req, res) => {
  res.redirect('/sales-mvp.html');
});

// ============================================================
// Lark API ヘルパー
// ============================================================

let tenantTokenCache = { token: null, expiresAt: 0 };

async function getTenantAccessToken() {
  if (tenantTokenCache.token && Date.now() < tenantTokenCache.expiresAt) {
    return tenantTokenCache.token;
  }

  const res = await fetch('https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ app_id: config.APP_ID, app_secret: config.APP_SECRET }),
  });

  const data = await res.json();
  if (data.code !== 0) throw new Error(`Lark auth failed: ${data.msg}`);

  tenantTokenCache = {
    token: data.tenant_access_token,
    expiresAt: Date.now() + (data.expire - 300) * 1000,
  };

  return data.tenant_access_token;
}

// メインDB用の汎用レコード取得
async function fetchRecords(token, tableId, pageSize = 100, pageToken = null) {
  let url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${config.MAIN_APP_TOKEN}/tables/${tableId}/records?page_size=${pageSize}`;
  if (pageToken) url += `&page_token=${pageToken}`;

  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Fetch records failed: ${data.msg}`);
  return data.data;
}

// メインDB用の汎用レコード作成
async function createRecord(token, tableId, fields) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${config.MAIN_APP_TOKEN}/tables/${tableId}/records`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Create record failed: ${data.msg}`);
  return data.data.record;
}

// メインDB用の汎用レコード更新
async function updateRecord(token, tableId, recordId, fields) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${config.MAIN_APP_TOKEN}/tables/${tableId}/records/${recordId}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Update record failed: ${data.msg}`);
  return data.data.record;
}

// 提出フォーム用のファイルアップロード
async function uploadFileToLark(token, filePath, fileName) {
  const form = new FormData();
  form.append('file_name', fileName);
  form.append('parent_type', 'bitable_file');
  form.append('parent_node', config.FORM_APP_TOKEN);
  form.append('size', String(fs.statSync(filePath).size));
  form.append('file', fs.createReadStream(filePath), fileName);

  const res = await fetch('https://open.larksuite.com/open-apis/drive/v1/medias/upload_all', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
    body: form,
  });

  const data = await res.json();
  if (data.code !== 0) throw new Error(`File upload failed: ${data.msg}`);
  return data.data.file_token;
}

// 提出フォーム用のレコード作成
async function createFormRecord(token, fields) {
  const url = `https://open.larksuite.com/open-apis/bitable/v1/apps/${config.FORM_APP_TOKEN}/tables/${config.FORM_TABLE_ID}/records`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ fields }),
  });
  const data = await res.json();
  if (data.code !== 0) throw new Error(`Record creation failed: ${data.msg}`);
  return data.data.record;
}

// ============================================================
// API: エンジニア提出フォーム（既存）
// ============================================================

app.post('/api/submit', upload.single('resumeFile'), async (req, res) => {
  try {
    const { salesPerson, engineerName, email, phone, desiredRate, availability } = req.body;

    if (!salesPerson || !engineerName || !email || !phone || !desiredRate) {
      return res.status(400).json({ error: '必須項目が入力されていません' });
    }
    if (!req.file) {
      return res.status(400).json({ error: '経歴書ファイルが添付されていません' });
    }

    const token = await getTenantAccessToken();
    const fileToken = await uploadFileToLark(token, req.file.path, req.file.originalname);

    const fields = {
      [config.FORM_FIELDS.SALES_PERSON]: salesPerson,
      [config.FORM_FIELDS.ENGINEER_NAME]: engineerName,
      [config.FORM_FIELDS.EMAIL]: email,
      [config.FORM_FIELDS.PHONE]: phone,
      [config.FORM_FIELDS.DESIRED_RATE]: desiredRate,
      [config.FORM_FIELDS.AVAILABILITY]: availability || '未定（要相談）',
      [config.FORM_FIELDS.RESUME_FILE]: [{ file_token: fileToken }],
    };

    const record = await createFormRecord(token, fields);
    fs.unlink(req.file.path, () => {});
    console.log(`[OK] エンジニア提出: ${record.record_id} (${engineerName})`);

    res.json({ success: true, recordId: record.record_id });
  } catch (err) {
    console.error('[ERROR] 提出失敗:', err.message);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message || '送信に失敗しました' });
  }
});

// ============================================================
// Lark リンクフィールドのマッチング
// リンクフィールドは [{record_ids:['recXXX'], table_id:...}] の形式
// ============================================================
function linkContains(linkField, recordId) {
  if (!linkField) return false;
  if (typeof linkField === 'string') return linkField === recordId;
  if (Array.isArray(linkField)) {
    return linkField.some(item => {
      if (typeof item === 'string') return item === recordId;
      if (item && Array.isArray(item.record_ids)) return item.record_ids.includes(recordId);
      return false;
    });
  }
  if (linkField.record_ids) return linkField.record_ids.includes(recordId);
  return false;
}

// ============================================================
// API: エージェント登録フォーム（公開・認証不要）
// ============================================================

app.post('/api/agent-register', upload.single('idDocument'), async (req, res) => {
  try {
    const { name, furigana, dob, email, phone, contractType, address,
            currentPosition, salesExperience, existingEngineers,
            bankName, branchName, accountType, accountNumber, accountHolder } = req.body;

    if (!name || !furigana || !dob || !email || !phone || !contractType || !address) {
      return res.status(400).json({ error: '必須項目が入力されていません' });
    }
    if (!bankName || !branchName || !accountType || !accountNumber || !accountHolder) {
      return res.status(400).json({ error: '振込先口座情報が入力されていません' });
    }

    const token = await getTenantAccessToken();

    // 本人確認書類アップロード
    let fileToken = null;
    if (req.file) {
      const form = new FormData();
      form.append('file_name', req.file.originalname);
      form.append('parent_type', 'bitable_file');
      form.append('parent_node', config.MAIN_APP_TOKEN);
      form.append('size', String(fs.statSync(req.file.path).size));
      form.append('file', fs.createReadStream(req.file.path), req.file.originalname);

      const uploadRes = await fetch('https://open.larksuite.com/open-apis/drive/v1/medias/upload_all', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, ...form.getHeaders() },
        body: form,
      });
      const uploadData = await uploadRes.json();
      if (uploadData.code === 0) fileToken = uploadData.data.file_token;
      fs.unlink(req.file.path, () => {});
    }

    const fields = {
      '営業氏名': name,
      'フリガナ': furigana,
      '生年月日': dob,
      'メールアドレス': email,
      '電話番号': phone,
      '契約形態': contractType,
      '住所': address,
    };
    if (currentPosition) fields['現職・所属'] = currentPosition;
    if (salesExperience) fields['営業経験年数'] = salesExperience;
    if (existingEngineers) fields['既存エンジニア持ち込み'] = existingEngineers;
    if (fileToken) fields['本人確認書類'] = [{ file_token: fileToken }];

    // 口座情報
    fields['金融機関名'] = bankName;
    fields['支店名'] = branchName;
    fields['預金種別'] = accountType;
    fields['口座番号'] = accountNumber;
    fields['口座名義'] = accountHolder;

    const record = await createRecord(token, config.TABLES.SALES, fields);
    console.log(`[OK] エージェント登録: ${record.record_id} (${name})`);

    res.json({ success: true, recordId: record.record_id });
  } catch (err) {
    console.error('[ERROR] エージェント登録失敗:', err.message);
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ error: err.message || '登録に失敗しました' });
  }
});

// ============================================================
// API: 営業管理（メインDB）
// ============================================================

// --- ログイン（氏名で1件だけ返す） ---
app.post('/api/login', async (req, res) => {
  try {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: '氏名を入力してください' });

    const token = await getTenantAccessToken();
    const data = await fetchRecords(token, config.TABLES.SALES);
    const normalized = name.trim().replace(/\s+/g, '');
    const match = (data.items || []).find(r => (r.fields['営業氏名'] || '').replace(/\s+/g, '') === normalized);
    if (!match) return res.status(401).json({ error: '該当する氏名が見つかりません' });

    res.json({
      success: true,
      user: {
        recordId: match.record_id,
        salesId: match.fields['営業ID'] || '',
        name: match.fields['営業氏名'] || '',
      },
    });
  } catch (err) {
    console.error('[ERROR] /api/login:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 営業エージェント ---
app.get('/api/sales', async (req, res) => {
  try {
    const token = await getTenantAccessToken();
    const data = await fetchRecords(token, config.TABLES.SALES);
    const items = (data.items || []).map(r => ({
      id: r.record_id,
      salesId: r.fields['営業ID'] || '',
      name: r.fields['営業氏名'] || '',
      larkId: r.fields['LarkアカウントID'] || '',
      incentiveRate: r.fields['インセンティブ率(%)'] || 10,
    }));
    res.json({ success: true, total: data.total, items });
  } catch (err) {
    console.error('[ERROR] /api/sales:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- エンジニア一覧 ---
app.get('/api/engineers', async (req, res) => {
  try {
    const token = await getTenantAccessToken();
    const salesFilter = req.query.sales; // ?sales=recXXX
    const data = await fetchRecords(token, config.TABLES.ENGINEERS);
    let items = (data.items || []).map(r => ({
      id: r.record_id,
      engineerId: r.fields['要員ID'] || '',
      name: r.fields['氏名'] || '',
      skills: r.fields['必須技術スタック'] || '',
      experience: r.fields['経験年数'] || '',
      availability: r.fields['面談可能枠'] || '',
      skillSheetUrl: r.fields['スキルシートURL'] ? r.fields['スキルシートURL'].link : '',
      salesLink: r.fields['所属営業'] || null,
    }));
    if (salesFilter) {
      items = items.filter(item => linkContains(item.salesLink, salesFilter));
    }
    res.json({ success: true, total: items.length, items });
  } catch (err) {
    console.error('[ERROR] /api/engineers:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 案件一覧 ---
app.get('/api/projects', async (req, res) => {
  try {
    const token = await getTenantAccessToken();
    const salesFilter = req.query.sales; // ?sales=recXXX
    const data = await fetchRecords(token, config.TABLES.PROJECTS);
    let items = (data.items || []).map(r => ({
      id: r.record_id,
      title: r.fields['案件タイトル'] || '',
      rawText: r.fields['案件本文_生データ'] || '',
      rate: r.fields['単価'] || '',
      settlement: r.fields['精算条件'] || '',
      station: r.fields['最寄り駅'] || '',
      requirements: r.fields['必須条件'] || '',
      status: r.fields['提案ステータス'] || '',
      proposalText: r.fields['提案メール文面'] || '',
      sender: r.fields['送信元'] || '',
      matchedEngineer: r.fields['マッチした要員'] || null,
      salesLink: r.fields['担当営業'] || null,
    }));
    if (salesFilter) {
      items = items.filter(item => linkContains(item.salesLink, salesFilter));
    }
    res.json({ success: true, total: items.length, items });
  } catch (err) {
    console.error('[ERROR] /api/projects:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 案件 新規登録 ---
app.post('/api/projects', async (req, res) => {
  try {
    const { title, rawText, rate, settlement, station, requirements, sender } = req.body;
    if (!title) return res.status(400).json({ error: '案件タイトルは必須です' });

    const token = await getTenantAccessToken();
    const fields = {
      '案件タイトル': title,
      '提案ステータス': '未提案',
    };
    if (rawText) fields['案件本文_生データ'] = rawText;
    if (rate) fields['単価'] = rate;
    if (settlement) fields['精算条件'] = settlement;
    if (station) fields['最寄り駅'] = station;
    if (requirements) fields['必須条件'] = requirements;
    if (sender) fields['送信元'] = sender;

    const record = await createRecord(token, config.TABLES.PROJECTS, fields);
    console.log(`[OK] 案件登録: ${record.record_id} (${title})`);

    res.json({ success: true, recordId: record.record_id });
  } catch (err) {
    console.error('[ERROR] POST /api/projects:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 案件ステータス更新 ---
app.patch('/api/projects/:recordId', async (req, res) => {
  try {
    const { recordId } = req.params;
    const token = await getTenantAccessToken();
    const record = await updateRecord(token, config.TABLES.PROJECTS, recordId, req.body);
    res.json({ success: true, record });
  } catch (err) {
    console.error('[ERROR] PATCH /api/projects:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 契約一覧 ---
app.get('/api/contracts', async (req, res) => {
  try {
    const token = await getTenantAccessToken();
    const salesFilter = req.query.sales; // ?sales=recXXX
    const data = await fetchRecords(token, config.TABLES.CONTRACTS);
    let items = (data.items || []).map(r => ({
      id: r.record_id,
      contractId: r.fields['契約ID'] || '',
      clientName: r.fields['クライアント名'] || '',
      rate: r.fields['契約単価'] || 0,
      settlement: r.fields['精算条件'] || '',
      startDate: r.fields['稼働開始日'] || null,
      endDate: r.fields['稼働終了予定日'] || null,
      status: r.fields['契約ステータス'] || '',
      projectLink: r.fields['案件'] || null,
      engineerLink: r.fields['エンジニア'] || null,
      salesLink: r.fields['担当営業'] || null,
    }));
    if (salesFilter) {
      items = items.filter(item => linkContains(item.salesLink, salesFilter));
    }
    res.json({ success: true, total: items.length, items });
  } catch (err) {
    console.error('[ERROR] /api/contracts:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- インセンティブ（報酬）一覧 ---
app.get('/api/incentives', async (req, res) => {
  try {
    const token = await getTenantAccessToken();
    const salesFilter = req.query.sales; // ?sales=recXXX
    const data = await fetchRecords(token, config.TABLES.INCENTIVE);
    let items = (data.items || []).map(r => ({
      id: r.record_id,
      incentiveId: r.fields['インセンティブID'] || '',
      month: r.fields['対象年月'] || '',
      salesAmount: r.fields['売上金額'] || 0,
      rate: r.fields['インセンティブ率(%)'] || 0,
      amount: r.fields['インセンティブ金額'] || 0,
      paymentStatus: r.fields['支払ステータス'] || '',
      salesLink: r.fields['担当営業'] || null,
    }));
    if (salesFilter) {
      items = items.filter(item => linkContains(item.salesLink, salesFilter));
    }
    res.json({ success: true, total: items.length, items });
  } catch (err) {
    console.error('[ERROR] /api/incentives:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 月次明細 ---
app.get('/api/monthly', async (req, res) => {
  try {
    const token = await getTenantAccessToken();
    const data = await fetchRecords(token, config.TABLES.MONTHLY);
    const items = (data.items || []).map(r => ({
      id: r.record_id,
      detailId: r.fields['明細ID'] || '',
      month: r.fields['対象年月'] || '',
      hours: r.fields['実働時間'] || 0,
      amount: r.fields['精算金額'] || 0,
      note: r.fields['備考'] || '',
      contractLink: r.fields['契約'] || null,
    }));
    res.json({ success: true, total: data.total, items });
  } catch (err) {
    console.error('[ERROR] /api/monthly:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- 請求一覧 ---
app.get('/api/invoices', async (req, res) => {
  try {
    const token = await getTenantAccessToken();
    const data = await fetchRecords(token, config.TABLES.INVOICES);
    const items = (data.items || []).map(r => ({
      id: r.record_id,
      invoiceId: r.fields['請求ID'] || '',
      amount: r.fields['請求金額'] || 0,
      invoiceDate: r.fields['請求日'] || null,
      dueDate: r.fields['入金予定日'] || null,
      paidDate: r.fields['入金実績日'] || null,
      status: r.fields['請求ステータス'] || '',
      monthlyLink: r.fields['月次明細'] || null,
    }));
    res.json({ success: true, total: data.total, items });
  } catch (err) {
    console.error('[ERROR] /api/invoices:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// --- ダッシュボード集計（全テーブル横断） ---
app.get('/api/dashboard', async (req, res) => {
  try {
    const token = await getTenantAccessToken();
    const salesFilter = req.query.sales; // ?sales=recXXX

    const matchesSales = (linkField) => {
      if (!salesFilter) return true;
      return linkContains(linkField, salesFilter);
    };

    const [salesData, engData, projData, contractData, incData] = await Promise.all([
      fetchRecords(token, config.TABLES.SALES),
      fetchRecords(token, config.TABLES.ENGINEERS),
      fetchRecords(token, config.TABLES.PROJECTS),
      fetchRecords(token, config.TABLES.CONTRACTS),
      fetchRecords(token, config.TABLES.INCENTIVE),
    ]);

    const engineers = (engData.items || []).filter(r => matchesSales(r.fields['所属営業']));
    const projects = (projData.items || []).filter(r => matchesSales(r.fields['担当営業']));
    const contracts = (contractData.items || []).filter(r => matchesSales(r.fields['担当営業']));
    const incentives = (incData.items || []).filter(r => matchesSales(r.fields['担当営業']));

    const activeContracts = contracts.filter(r => r.fields['契約ステータス'] === '稼働中');
    const monthlyStock = activeContracts.reduce((sum, r) => {
      const rate = r.fields['契約単価'] || 0;
      const incRate = 0.10; // 10% to sales agent
      return sum + rate * incRate;
    }, 0);

    const totalIncentive = incentives.reduce((sum, r) => sum + (Number(r.fields['インセンティブ金額']) || 0), 0);

    res.json({
      success: true,
      summary: {
        salesCount: salesData.total || 0,
        engineerCount: engineers.length,
        projectCount: projects.length,
        activeContracts: activeContracts.length,
        monthlyStock: Math.round(monthlyStock),
        totalIncentive: totalIncentive,
      },
    });
  } catch (err) {
    console.error('[ERROR] /api/dashboard:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================================
// サーバー起動
// ============================================================

const PORT = process.env.PORT || config.PORT;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
  console.log(`\n  SAKIGAKE Server running at http://localhost:${PORT}`);
  console.log(`  Binding: ${HOST}:${PORT} (external access enabled)`);
  console.log(`\n  Pages:`);
  console.log(`    ログイン:            http://localhost:${PORT}/login.html`);
  console.log(`    エンジニアフォーム:  http://localhost:${PORT}/`);
  console.log(`    エージェント登録:    http://localhost:${PORT}/sakigake-agent.html`);
  console.log(`    営業ダッシュボード:  http://localhost:${PORT}/sales-mvp.html`);
  console.log(`    案件一覧:            http://localhost:${PORT}/projects.html`);
  console.log(`    新規案件登録:        http://localhost:${PORT}/project-new.html`);
  console.log(`\n  API:`);
  console.log(`    GET  /api/dashboard   - ダッシュボード集計`);
  console.log(`    GET  /api/sales       - 営業一覧`);
  console.log(`    GET  /api/engineers   - エンジニア一覧`);
  console.log(`    GET  /api/projects    - 案件一覧`);
  console.log(`    POST /api/projects    - 案件登録`);
  console.log(`    GET  /api/contracts   - 契約一覧`);
  console.log(`    GET  /api/incentives  - インセンティブ一覧`);
  console.log(`    GET  /api/monthly     - 月次明細`);
  console.log(`    GET  /api/invoices    - 請求一覧`);
  console.log('');
});
