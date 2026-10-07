/**
 * テクマくん毎日ルーレット - GAS backend
 *
 * 使い方:
 * 1) CONFIG.SPREADSHEET_ID と CONFIG.LINE_CHANNEL_ID を設定
 * 2) setup() を一度実行
 * 3) ウェブアプリとして「次のユーザーとして実行: 自分」「アクセス: 全員」でデプロイ
 * 4) /exec URL を GitHub 側 js/config.js に設定
 */

const CONFIG = {
  SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID',
  LINE_CHANNEL_ID: 'YOUR_LINE_LOGIN_CHANNEL_ID',
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

function doGet() {
  return json_({ ok: true, service: 'tekma-daily-roulette', version: 1 });
}

function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json_({ ok: false, message: 'リクエストが空です。' });
    }

    const body = JSON.parse(e.postData.contents);
    const action = String(body.action || '');
    const user = verifyLineIdToken_(body.idToken);
    const userHash = hashUser_(user.sub);

    if (action === 'status') return json_(getStatus_(userHash));
    if (action === 'spin') return json_(spin_(userHash));
    if (action === 'redeem') return json_(redeem_(userHash, String(body.claimId || '')));

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
  if (prizes.getLastRow() === 0) {
    prizes.getRange(1, 1, 4, 4).setValues([
      ['id', 'name', 'weight', 'enabled'],
      ['medal10', 'メダル10枚', 50, true],
      ['free1', 'クレーンゲーム 1PLAY無料', 20, true],
      ['extra1', 'クレーンゲーム 1PLAY増量', 30, true]
    ]);
    prizes.setFrozenRows(1);
  }

  log.autoResizeColumns(1, LOG_HEADERS.length);
  prizes.autoResizeColumns(1, 4);
  return 'セットアップ完了';
}

function getStatus_(userHash) {
  const today = today_();
  const row = findTodayRow_(userHash, today);
  if (!row) return { ok: true, state: 'available' };

  const rec = row.record;
  if (rec.redeemedAt) {
    return { ok: true, state: 'redeemed' };
  }

  return {
    ok: true,
    state: 'won',
    prize: { id: rec.prizeId, name: rec.prizeName },
    claimId: rec.claimId,
    expiresAt: `${today}T23:59:59+09:00`
  };
}

function spin_(userHash) {
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const today = today_();
    const existing = findTodayRow_(userHash, today);
    if (existing) {
      if (existing.record.redeemedAt) return { ok: true, state: 'redeemed' };
      return {
        ok: true,
        state: 'won',
        prize: { id: existing.record.prizeId, name: existing.record.prizeName },
        claimId: existing.record.claimId,
        expiresAt: `${today}T23:59:59+09:00`
      };
    }

    const prize = drawPrize_();
    const now = new Date();
    const claimId = Utilities.getUuid().replace(/-/g, '').slice(0, 12).toUpperCase();
    const dailyKey = `${today}:${userHash}`;
    const sheet = getLogSheet_();

    sheet.appendRow([
      dailyKey,
      today,
      userHash,
      prize.id,
      prize.name,
      now,
      '',
      claimId
    ]);

    return {
      ok: true,
      state: 'won',
      prize: { id: prize.id, name: prize.name },
      claimId,
      expiresAt: `${today}T23:59:59+09:00`
    };
  } finally {
    lock.releaseLock();
  }
}

function redeem_(userHash, claimId) {
  if (!claimId) throw new Error('特典IDがありません。');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const today = today_();
    const found = findTodayRow_(userHash, today);
    if (!found) throw new Error('本日の特典が見つかりません。');

    const rec = found.record;
    if (rec.claimId !== claimId) throw new Error('特典IDが一致しません。');
    if (rec.redeemedAt) return { ok: true, state: 'redeemed' };

    // 今日のレコードだけを検索しているため、日付が変わった特典はここに到達しません。
    found.sheet.getRange(found.row, 7).setValue(new Date());
    SpreadsheetApp.flush();
    return { ok: true, state: 'redeemed' };
  } finally {
    lock.releaseLock();
  }
}

function drawPrize_() {
  const sheet = getPrizeSheet_();
  const last = sheet.getLastRow();
  if (last < 2) throw new Error('景品設定がありません。');

  const rows = sheet.getRange(2, 1, last - 1, 4).getValues();
  const prizes = rows
    .filter(r => String(r[0]).trim() && String(r[1]).trim() && Number(r[2]) > 0 && isEnabled_(r[3]))
    .map(r => ({ id: String(r[0]).trim(), name: String(r[1]).trim(), weight: Number(r[2]) }));

  if (!prizes.length) throw new Error('有効な景品がありません。');

  const total = prizes.reduce((sum, p) => sum + p.weight, 0);
  let roll = Math.random() * total;
  for (const prize of prizes) {
    roll -= prize.weight;
    if (roll < 0) return prize;
  }
  return prizes[prizes.length - 1];
}

function verifyLineIdToken_(idToken) {
  if (!idToken) throw new Error('LINE認証情報がありません。');
  if (!CONFIG.LINE_CHANNEL_ID || CONFIG.LINE_CHANNEL_ID.startsWith('YOUR_')) {
    throw new Error('GAS側のLINE_CHANNEL_IDが未設定です。');
  }

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
  return data;
}

function hashUser_(userId) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, userId, Utilities.Charset.UTF_8);
  return bytes.map(b => (b + 256) % 256).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

function findTodayRow_(userHash, date) {
  const sheet = getLogSheet_();
  const last = sheet.getLastRow();
  if (last < 2) return null;

  const key = `${date}:${userHash}`;
  const finder = sheet.getRange(2, 1, last - 1, 1).createTextFinder(key).matchEntireCell(true);
  const cell = finder.findNext();
  if (!cell) return null;

  const row = cell.getRow();
  const values = sheet.getRange(row, 1, 1, LOG_HEADERS.length).getValues()[0];
  return {
    sheet,
    row,
    record: {
      dailyKey: values[0],
      date: values[1],
      userHash: values[2],
      prizeId: values[3],
      prizeName: values[4],
      spunAt: values[5],
      redeemedAt: values[6],
      claimId: values[7]
    }
  };
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
  if (!CONFIG.SPREADSHEET_ID || CONFIG.SPREADSHEET_ID.startsWith('YOUR_')) {
    throw new Error('SPREADSHEET_IDが未設定です。');
  }
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
