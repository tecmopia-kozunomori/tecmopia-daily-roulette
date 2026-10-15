/**
 * テクモピア毎日ルーレット - GAS backend v9 (ハズレ追加版)
 *
 * 主な変更:
 * - LINE IDトークン検証結果を短時間キャッシュ
 * - 当日の利用状態は Script Properties を高速ストアとして利用
 * - スプレッドシート履歴への書き込みは画面処理と分離（sync）
 * - 景品設定は Script Properties にキャッシュ
 *
 * 初回だけ:
 * 1) この Code.gs に差し替える
 * 2) setup() を実行（既存シートは壊しません）
 * 3) warmTodayState() を1回実行
 * 4) ウェブアプリを「新しいバージョン」で再デプロイ
 */

const CONFIG = {
  SPREADSHEET_ID: '1nB3mdRkocLBzDKqaPCLtqbaVVl4Td00SIybVXlo365A',
  LINE_CHANNEL_ID: '2011910155',
  TIMEZONE: 'Asia/Tokyo',
  LOG_SHEET: 'ROULETTE_LOG',
  PRIZE_SHEET: 'PRIZES'
};

const LOG_HEADERS = [
  'dailyKey',
  'date',
  'userHash',
  'prizeId',
  'prizeName',
  'spunAt',
  'redeemedAt',
  'claimId'
];

const FAST = {
  STATE_PREFIX: 'ROULETTE_STATE:',
  MIGRATION_PREFIX: 'ROULETTE_MIGRATED:',
  PRIZE_CONFIG_KEY: 'ROULETTE_PRIZES_V1',
  ACTIVATION_DATE_KEY: 'ROULETTE_V8_ACTIVATION_DATE',
  AUTH_CACHE_SECONDS: 1800
};

function doGet() {
  return json_({ ok: true, service: 'tecmopia-daily-roulette', version: 9 });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, message: 'リクエストが空です。' });
    }

    const body = JSON.parse(e.postData.contents);
    const action = String(body.action || '');
    const userHash = verifyLineIdTokenCached_(body.idToken);

    ensureTodayMigration_();

    if (action === 'status') return json_(getStatusFast_(userHash));
    if (action === 'spin') return json_(spinFast_(userHash));
    if (action === 'redeem') return json_(redeemFast_(userHash, String(body.claimId || '')));
    if (action === 'sync') return json_(syncClaim_(userHash, String(body.claimId || '')));

    return json_({ ok: false, message: '不明な操作です。' });
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
    return json_({ ok: false, message: safeError_(err) });
  }
}

function setup() {
  const ss = getSpreadsheet_();

  let log = ss.getSheetByName(CONFIG.LOG_SHEET);
  if (!log) log = ss.insertSheet(CONFIG.LOG_SHEET);
  if (log.getLastRow() === 0) {
    log.getRange(1, 1, 1, LOG_HEADERS.length).setValues([LOG_HEADERS]);
    log.setFrozenRows(1);
  }

  let prizes = ss.getSheetByName(CONFIG.PRIZE_SHEET);
  if (!prizes) prizes = ss.insertSheet(CONFIG.PRIZE_SHEET);
  ensurePrizeSheetDefaults_(prizes);

  log.autoResizeColumns(1, LOG_HEADERS.length);
  prizes.autoResizeColumns(1, 4);
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty(FAST.ACTIVATION_DATE_KEY)) {
    props.setProperty(FAST.ACTIVATION_DATE_KEY, today_());
  }
  refreshPrizeConfig();
  return 'セットアップ完了（v9ハズレ追加版）';
}


function ensurePrizeSheetDefaults_(sheet) {
  const defaults = [
    ['id', 'name', 'weight', 'enabled'],
    ['medal10', 'メダル10枚', 25, true],
    ['free1', 'クレーンゲーム 1PLAY無料', 25, true],
    ['extra1', 'クレーンゲーム 1PLAY増量', 25, true],
    ['lose', 'ハズレ', 25, true]
  ];

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, defaults.length, 4).setValues(defaults);
    sheet.setFrozenRows(1);
    return;
  }

  const values = sheet.getDataRange().getValues();
  if (!values.length) {
    sheet.getRange(1, 1, defaults.length, 4).setValues(defaults);
    sheet.setFrozenRows(1);
    return;
  }

  if (String(values[0][0]).trim() !== 'id') {
    sheet.insertRows(1, 1);
    sheet.getRange(1, 1, 1, 4).setValues([defaults[0]]);
  }

  const idToRow = {};
  const last = sheet.getLastRow();
  if (last >= 2) {
    const rows = sheet.getRange(2, 1, last - 1, 4).getValues();
    rows.forEach((r, i) => { if (String(r[0]).trim()) idToRow[String(r[0]).trim()] = i + 2; });
  }

  defaults.slice(1).forEach(def => {
    const row = idToRow[def[0]];
    if (row) {
      sheet.getRange(row, 1, 1, 4).setValues([[def[0], def[1], 25, true]]);
    } else {
      sheet.appendRow([def[0], def[1], 25, true]);
    }
  });
}

/** 景品確率をPRIZESシートから高速ストアへ反映。確率変更後に実行してください。 */
function refreshPrizeConfig() {
  const sheet = getPrizeSheet_();
  ensurePrizeSheetDefaults_(sheet);
  const last = sheet.getLastRow();
  if (last < 2) throw new Error('景品設定がありません。');

  const rows = sheet.getRange(2, 1, last - 1, 4).getValues();
  const prizes = rows
    .filter(r => String(r[0]).trim() && String(r[1]).trim() && Number(r[2]) > 0 && isEnabled_(r[3]))
    .map(r => ({ id: String(r[0]).trim(), name: String(r[1]).trim(), weight: Number(r[2]) }));

  if (!prizes.length) throw new Error('有効な景品がありません。');
  PropertiesService.getScriptProperties().setProperty(FAST.PRIZE_CONFIG_KEY, JSON.stringify(prizes));
  return `景品設定を反映しました（${prizes.length}件）`;
}

/** デプロイ直後に1回実行すると、その日の既存利用履歴を高速ストアへ先読みします。 */
function warmTodayState() {
  const today = today_();
  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(FAST.MIGRATION_PREFIX + today);
  ensureTodayMigration_();
  return `本日(${today})の利用状態を高速ストアへ反映しました。`;
}

function getStatusFast_(userHash) {
  const today = today_();
  const state = getState_(userHash, today);
  if (!state) return { ok: true, state: 'available' };
  return responseFromState_(state);
}

function spinFast_(userHash) {
  const lock = LockService.getScriptLock();
  lock.waitLock(6000);
  try {
    const today = today_();
    const existing = getState_(userHash, today);
    if (existing) return responseFromState_(existing);

    const prize = drawPrizeFast_();
    const now = new Date();
    const claimId = Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
    const state = {
      date: today,
      userHash,
      prizeId: prize.id,
      prizeName: prize.name,
      spunAt: now.toISOString(),
      redeemedAt: '',
      claimId
    };

    setState_(state);
    return responseFromState_(state);
  } finally {
    lock.releaseLock();
  }
}

function redeemFast_(userHash, claimId) {
  if (!claimId) throw new Error('特典IDがありません。');

  const lock = LockService.getScriptLock();
  lock.waitLock(6000);
  try {
    const today = today_();
    const state = getState_(userHash, today);
    if (!state) throw new Error('本日の特典が見つかりません。');
    if (state.claimId !== claimId) throw new Error('特典IDが一致しません。');
    if (!state.redeemedAt) {
      state.redeemedAt = new Date().toISOString();
      setState_(state);
    }
    return { ok: true, state: 'redeemed', claimId: state.claimId };
  } finally {
    lock.releaseLock();
  }
}

/**
 * スプレッドシートは監査ログ用。画面側はこの処理を待たない。
 * 同じclaimIdの同期が複数回来ても重複行を作らない。
 */
function syncClaim_(userHash, claimId) {
  if (!claimId) return { ok: true, synced: false };

  const today = today_();
  const state = getState_(userHash, today);
  if (!state || state.claimId !== claimId) return { ok: true, synced: false };

  const lock = LockService.getScriptLock();
  lock.waitLock(8000);
  try {
    const sheet = getLogSheet_();
    const dailyKey = `${today}:${userHash}`;
    const last = sheet.getLastRow();
    let row = 0;

    if (last >= 2) {
      const cell = sheet.getRange(2, 1, last - 1, 1)
        .createTextFinder(dailyKey)
        .matchEntireCell(true)
        .findNext();
      if (cell) row = cell.getRow();
    }

    const values = [
      dailyKey,
      today,
      userHash,
      state.prizeId,
      state.prizeName,
      state.spunAt ? new Date(state.spunAt) : new Date(),
      state.redeemedAt ? new Date(state.redeemedAt) : '',
      state.claimId
    ];

    if (row) {
      sheet.getRange(row, 1, 1, LOG_HEADERS.length).setValues([values]);
    } else {
      sheet.getRange(last + 1, 1, 1, LOG_HEADERS.length).setValues([values]);
    }
    return { ok: true, synced: true };
  } finally {
    lock.releaseLock();
  }
}

function responseFromState_(state) {
  if (state.redeemedAt) {
    return { ok: true, state: 'redeemed', claimId: state.claimId };
  }
  return {
    ok: true,
    state: 'won',
    prize: { id: state.prizeId, name: state.prizeName },
    claimId: state.claimId,
    expiresAt: `${state.date}T23:59:59+09:00`
  };
}

function drawPrizeFast_() {
  const props = PropertiesService.getScriptProperties();
  let raw = props.getProperty(FAST.PRIZE_CONFIG_KEY);
  if (!raw) {
    refreshPrizeConfig();
    raw = props.getProperty(FAST.PRIZE_CONFIG_KEY);
  }

  const prizes = JSON.parse(raw || '[]');
  if (!prizes.length) throw new Error('有効な景品がありません。');

  const total = prizes.reduce((sum, p) => sum + Number(p.weight || 0), 0);
  let roll = Math.random() * total;
  for (const prize of prizes) {
    roll -= Number(prize.weight || 0);
    if (roll < 0) return prize;
  }
  return prizes[prizes.length - 1];
}

function getState_(userHash, date) {
  const raw = PropertiesService.getScriptProperties().getProperty(stateKey_(date, userHash));
  if (!raw) return null;
  try {
    const state = JSON.parse(raw);
    return state && state.date === date ? state : null;
  } catch (_) {
    return null;
  }
}

function setState_(state) {
  PropertiesService.getScriptProperties().setProperty(
    stateKey_(state.date, state.userHash),
    JSON.stringify(state)
  );
}

function stateKey_(date, userHash) {
  return `${FAST.STATE_PREFIX}${date}:${userHash}`;
}

/**
 * 1日1回だけ既存スプレッドシートを読み、その日の状態を高速ストアへ移行。
 * 通常利用時はスプレッドシート検索をしません。
 */
function ensureTodayMigration_() {
  const today = today_();
  const props = PropertiesService.getScriptProperties();
  const marker = FAST.MIGRATION_PREFIX + today;
  if (props.getProperty(marker) === '1') return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(6000)) return;
  try {
    if (props.getProperty(marker) === '1') return;

    // 古い高速状態だけ削除（景品設定など他のプロパティは残す）。
    const all = props.getProperties();
    const todayPrefix = `${FAST.STATE_PREFIX}${today}:`;
    Object.keys(all).forEach(key => {
      if (key.indexOf(FAST.STATE_PREFIX) === 0 && key.indexOf(todayPrefix) !== 0) {
        props.deleteProperty(key);
      }
      if (key.indexOf(FAST.MIGRATION_PREFIX) === 0 && key !== marker) {
        props.deleteProperty(key);
      }
    });

    // v8へ切り替えた当日だけ、旧バージョンの既存履歴を取り込む。
    // 翌日以降はスプレッドシートを読まず、ここが高速化の要点。
    const activationDate = props.getProperty(FAST.ACTIVATION_DATE_KEY) || today;
    if (activationDate === today) {
      const sheet = getLogSheet_();
      const last = sheet.getLastRow();
      if (last >= 2) {
        const rows = sheet.getRange(2, 1, last - 1, LOG_HEADERS.length).getValues();
        rows.forEach(r => {
          const date = normalizeDateValue_(r[1]);
          if (date !== today) return;
          const userHash = String(r[2] || '').trim();
          if (!userHash) return;
          const state = {
            date: today,
            userHash,
            prizeId: String(r[3] || ''),
            prizeName: String(r[4] || ''),
            spunAt: r[5] instanceof Date ? r[5].toISOString() : String(r[5] || ''),
            redeemedAt: r[6] instanceof Date ? r[6].toISOString() : String(r[6] || ''),
            claimId: String(r[7] || '')
          };
          if (state.claimId) setState_(state);
        });
      }
    }

    props.setProperty(marker, '1');
  } finally {
    lock.releaseLock();
  }
}

function verifyLineIdTokenCached_(idToken) {
  if (!idToken) throw new Error('LINE認証情報がありません。');
  if (!CONFIG.LINE_CHANNEL_ID || CONFIG.LINE_CHANNEL_ID.startsWith('YOUR_')) {
    throw new Error('GAS側のLINE_CHANNEL_IDが未設定です。');
  }

  const cache = CacheService.getScriptCache();
  const key = 'AUTH:' + digestHex_(idToken).slice(0, 48);
  const cached = cache.get(key);
  if (cached) return cached;

  const response = UrlFetchApp.fetch('https://api.line.me/oauth2/v2.1/verify', {
    method: 'post',
    payload: {
      id_token: idToken,
      client_id: CONFIG.LINE_CHANNEL_ID
    },
    muteHttpExceptions: true
  });

  if (response.getResponseCode() !== 200) {
    throw new Error('LINE認証の確認に失敗しました。');
  }

  const data = JSON.parse(response.getContentText());
  if (!data.sub || String(data.aud) !== String(CONFIG.LINE_CHANNEL_ID)) {
    throw new Error('LINE認証情報が正しくありません。');
  }

  const userHash = hashUser_(data.sub);
  cache.put(key, userHash, FAST.AUTH_CACHE_SECONDS);
  return userHash;
}

function digestHex_(value) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, value, Utilities.Charset.UTF_8);
  return bytes.map(b => (b + 256) % 256).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hashUser_(userId) {
  return digestHex_(userId).slice(0, 32);
}

function normalizeDateValue_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  const s = String(value || '').trim();
  const m = s.match(/^(\d{4})[-\/]?(\d{1,2})[-\/]?(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}`;
  return s;
}

function today_() {
  return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd');
}

function isEnabled_(value) {
  if (value === true) return true;
  const s = String(value).trim().toLowerCase();
  return s === 'true' || s === '1' || s === 'yes' || s === 'on';
}

function getSpreadsheet_() {
  return SpreadsheetApp.openById(CONFIG.SPREADSHEET_ID);
}

function getLogSheet_() {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.LOG_SHEET);
  if (!sheet) throw new Error('ROULETTE_LOGシートがありません。setup()を実行してください。');
  return sheet;
}

function getPrizeSheet_() {
  const sheet = getSpreadsheet_().getSheetByName(CONFIG.PRIZE_SHEET);
  if (!sheet) throw new Error('PRIZESシートがありません。setup()を実行してください。');
  return sheet;
}

function json_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function safeError_(err) {
  const msg = err && err.message ? String(err.message) : '処理中にエラーが発生しました。';
  return msg.slice(0, 200);
}
