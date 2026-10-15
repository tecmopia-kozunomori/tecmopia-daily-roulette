(function () {
  'use strict';

  class RouletteApi {
    constructor(config) {
      this.config = config;
      const missing = !config.LIFF_ID || config.LIFF_ID.startsWith('YOUR_') ||
        !config.GAS_WEB_APP_URL || config.GAS_WEB_APP_URL.startsWith('YOUR_');
      this.demo = config.FORCE_DEMO === true || (config.FORCE_DEMO !== false && missing);
      this.idToken = null;
      this.profile = null;
      this.demoKey = 'tekma_daily_roulette_demo_v2';
    }

    async init() {
      if (this.demo) {
        this.profile = { displayName: 'デモユーザー' };
        return { demo: true, profile: this.profile };
      }

      if (!window.liff) throw new Error('LIFF SDKを読み込めませんでした。');

      await liff.init({
        liffId: this.config.LIFF_ID,
        withLoginOnExternalBrowser: true
      });

      if (!liff.isLoggedIn()) {
        liff.login({ redirectUri: window.location.href });
        return new Promise(() => {});
      }

      this.idToken = liff.getIDToken();
      if (!this.idToken) {
        throw new Error('LINE認証情報を取得できませんでした。LIFFのopenidスコープを確認してください。');
      }

      // getProfile() は追加通信になるため使わず、IDトークンをローカルで読む。
      try {
        const decoded = liff.getDecodedIDToken && liff.getDecodedIDToken();
        this.profile = decoded ? { displayName: decoded.name || '' } : null;
      } catch (_) {
        this.profile = null;
      }

      return { demo: false, profile: this.profile };
    }

    async status() {
      if (this.demo) return this.demoStatus();
      return this.post({ action: 'status', idToken: this.idToken }, { timeoutMs: 8500, retries: 1 });
    }

    async spin() {
      if (this.demo) return this.demoSpin();
      const result = await this.post({ action: 'spin', idToken: this.idToken }, { timeoutMs: 9500, retries: 1 });
      if (result && result.claimId) this.sync(result.claimId);
      return result;
    }

    async redeem(claimId) {
      if (this.demo) return this.demoRedeem(claimId);
      const result = await this.post({ action: 'redeem', idToken: this.idToken, claimId }, { timeoutMs: 9500, retries: 1 });
      if (claimId) this.sync(claimId);
      return result;
    }

    // 履歴シートへの同期は画面操作を待たせない。
    sync(claimId) {
      if (this.demo || !claimId || !this.idToken) return;
      this.post(
        { action: 'sync', idToken: this.idToken, claimId },
        { timeoutMs: 12000, retries: 0, silent: true, keepalive: true }
      ).catch(() => {});
    }

    async post(payload, options = {}) {
      const timeoutMs = options.timeoutMs || 9000;
      const retries = Number.isInteger(options.retries) ? options.retries : 0;
      let lastError = null;

      for (let attempt = 0; attempt <= retries; attempt++) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(this.config.GAS_WEB_APP_URL, {
            method: 'POST',
            redirect: 'follow',
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
            body: JSON.stringify(payload),
            signal: controller.signal,
            keepalive: !!options.keepalive
          });

          clearTimeout(timer);
          if (!response.ok) throw new Error('サーバーエラーが発生しました。');
          const data = await response.json();
          if (!data.ok) throw new Error(data.message || '処理に失敗しました。');
          return data;
        } catch (err) {
          clearTimeout(timer);
          lastError = err;
          if (attempt < retries) {
            await this.wait(350 + attempt * 250);
            continue;
          }
        }
      }

      if (options.silent) throw lastError || new Error('通信エラー');
      if (lastError && lastError.name === 'AbortError') {
        throw new Error('通信に時間がかかっています。もう一度お試しください。');
      }
      throw new Error('サーバーに接続できませんでした。通信環境をご確認ください。');
    }

    demoToday() {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    demoRead() {
      try {
        const raw = localStorage.getItem(this.demoKey);
        return raw ? JSON.parse(raw) : null;
      } catch (_) {
        return null;
      }
    }

    demoWrite(value) {
      try { localStorage.setItem(this.demoKey, JSON.stringify(value)); } catch (_) {}
    }

    async demoStatus() {
      await this.wait(180);
      const rec = this.demoRead();
      if (!rec || rec.date !== this.demoToday()) return { ok: true, state: 'available' };
      return {
        ok: true,
        state: rec.redeemed ? 'redeemed' : 'won',
        prize: rec.prize,
        claimId: rec.claimId,
        expiresAt: rec.expiresAt
      };
    }

    async demoSpin() {
      await this.wait(180);
      const current = await this.demoStatus();
      if (current.state !== 'available') return current;

      const prizes = [
        { id: 'medal10', name: 'メダル10枚' },
        { id: 'free1', name: 'クレーンゲーム 1PLAY無料' },
        { id: 'extra1', name: 'クレーンゲーム 1PLAY増量' },
        { id: 'lose', name: 'ハズレ' }
      ];
      const prize = prizes[Math.floor(Math.random() * prizes.length)];

      const claimId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`).slice(0, 8).toUpperCase();
      const rec = {
        date: this.demoToday(),
        prize,
        claimId,
        redeemed: false,
        expiresAt: `${this.demoToday()}T23:59:59+09:00`
      };
      this.demoWrite(rec);
      return { ok: true, state: 'won', prize, claimId, expiresAt: rec.expiresAt };
    }

    async demoRedeem(claimId) {
      await this.wait(220);
      const rec = this.demoRead();
      if (!rec || rec.date !== this.demoToday() || rec.claimId !== claimId) {
        throw new Error('特典情報を確認できませんでした。');
      }
      rec.redeemed = true;
      this.demoWrite(rec);
      return { ok: true, state: 'redeemed' };
    }

    wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
  }

  window.RouletteApi = RouletteApi;
})();
