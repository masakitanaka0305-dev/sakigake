// SAKIGAKE — Lark Base API 接続設定
require('dotenv').config();

module.exports = {
  // Lark App 認証情報
  APP_ID: process.env.APP_ID,
  APP_SECRET: process.env.APP_SECRET,

  // === エンジニア提出フォーム用 Lark Base ===
  FORM_APP_TOKEN: process.env.FORM_APP_TOKEN,
  FORM_TABLE_ID: process.env.FORM_TABLE_ID,

  // 提出フォームのフィールド名
  FORM_FIELDS: {
    SALES_PERSON: '紹介営業マン',
    ENGINEER_NAME: 'エンジニア名',
    EMAIL: 'メールアドレス',
    PHONE: '電話番号',
    DESIRED_RATE: '希望単価',
    AVAILABILITY: '稼働開始時期',
    RESUME_FILE: '経歴書',
  },

  // === 営業管理用 Lark Base（メインDB） ===
  MAIN_APP_TOKEN: process.env.MAIN_APP_TOKEN,

  TABLES: {
    SALES:      'tblk1rXTWyXtKoFU',  // 営業エージェント
    ENGINEERS:  'tblT1XcbcHTqfFu7',  // エンジニア
    PROJECTS:   'tblWEFWu8n5EWPI3',  // 案件
    CONTRACTS:  'tblzfIBwiox8Sclk',  // 契約
    MONTHLY:    'tbl22STZHLtfypie',  // 月次明細
    INVOICES:   'tbloxT2Gnko2POVz',  // 請求
    INCENTIVE:  'tbl7fofGX04Y2x92',  // インセンティブ
  },

  // 後方互換（旧キー名 → 提出フォーム用）
  get APP_TOKEN() { return this.FORM_APP_TOKEN; },
  get TABLE_ID() { return this.FORM_TABLE_ID; },
  get FIELDS() { return this.FORM_FIELDS; },

  // サーバー設定
  PORT: process.env.PORT || 3000,
};
