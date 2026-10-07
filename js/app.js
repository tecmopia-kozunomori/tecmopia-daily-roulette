(function () {
  'use strict';

  const cfg = window.TEKMA_CONFIG;
  const api = new window.RouletteApi(cfg);

  const $ = (id) => document.getElementById(id);
  const views = ['wheelView', 'resultView', 'doneView', 'errorView'];
  const wheel = $('wheel');
  const spinButton = $('spinButton');
  const redeemButton = $('redeemButton');
  const confirmModal = $('confirmModal');
  let currentRotation = 0;
  let activeClaim = null;
  let spinning = false;
  let clockTimer = null;

  const segmentData = [
    { id: 'medal10', short: '10枚', icon: '🪙' },
    { id: 'extra1', short: '+1PLAY', icon: '➕' },
    { id: 'medal10', short: '10枚', icon: '🪙' },
    { id: 'free1', short: '1PLAY無料', icon: '🎟️' },
    { id: 'medal10', short: '10枚', icon: '🪙' },
    { id: 'extra1', short: '+1PLAY', icon: '➕' },
    { id: 'medal10', short: '10枚', icon: '🪙' },
    { id: 'free1', short: '1PLAY無料', icon: '🎟️' },
    { id: 'extra1', short: '+1PLAY', icon: '➕' },
    { id: 'medal10', short: '10枚', icon: '🪙' }
  ];

  const prizeUi = {
    medal10: { icon: '🪙', defaultName: 'メダル10枚' },
    free1: { icon: '🎟️', defaultName: 'クレーンゲーム 1PLAY無料' },
    extra1: { icon: '➕', defaultName: 'クレーンゲーム 1PLAY増量' }
  };

  function showView(id) {
    views.forEach(v => { $(v).hidden = v !== id; });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function setConnection(text, state = 'ok') {
    $('connectionText').textContent = text;
    const card = $('connectionCard');
    card.dataset.state = state;
  }

  function formatToday() {
    const d = new Date();
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
  }

  function buildSegments() {
    const holder = $('segmentLabels');
    holder.replaceChildren();
    const count = segmentData.length;
    segmentData.forEach((seg, i) => {
      const angle = (360 / count) * i + 360 / count / 2;
      const node = document.createElement('div');
      node.className = `segment-label seg-${seg.id}`;
      node.style.setProperty('--angle', `${angle}deg`);
      node.innerHTML = `<span class="segment-label-inner"><span class="seg-icon">${seg.icon}</span><span>${seg.short}</span></span>`;
      holder.appendChild(node);
    });
  }

  function selectedIndexFor(prizeId) {
    const matches = segmentData
      .map((s, i) => s.id === prizeId ? i : -1)
      .filter(i => i >= 0);
    if (!matches.length) return 0;
    return matches[Math.floor(Math.random() * matches.length)];
  }

  function normalizeDeg(value) {
    return ((value % 360) + 360) % 360;
  }

  function signedDeg(value) {
    const deg = normalizeDeg(value);
    return deg > 180 ? deg - 360 : deg;
  }

  function setLabelsUpright(rotation) {
    const counter = -signedDeg(rotation);
    document.querySelectorAll('.segment-label-inner').forEach(node => {
      node.style.setProperty('--counter-rotation', `${counter}deg`);
    });
  }

  function playSpinSound(durationMs) {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const start = ctx.currentTime;
      const duration = durationMs / 1000;
      let t = 0;
      let step = 0.07;
      while (t < duration - 0.18) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'square';
        osc.frequency.value = 620;
        gain.gain.setValueAtTime(0.018, start + t);
        gain.gain.exponentialRampToValueAtTime(0.001, start + t + 0.025);
        osc.connect(gain).connect(ctx.destination);
        osc.start(start + t);
        osc.stop(start + t + 0.03);
        t += step;
        step = Math.min(step * 1.045, 0.28);
      }
      setTimeout(() => ctx.close().catch(() => {}), durationMs + 500);
    } catch (_) {}
  }

  function playWinSound() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const notes = [523.25, 659.25, 783.99, 1046.5];
      notes.forEach((freq, i) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = freq;
        const t = ctx.currentTime + i * 0.11;
        gain.gain.setValueAtTime(0.06, t);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.28);
        osc.connect(gain).connect(ctx.destination);
        osc.start(t);
        osc.stop(t + 0.3);
      });
      setTimeout(() => ctx.close().catch(() => {}), 1200);
    } catch (_) {}
  }

  function spinTo(prizeId) {
    const index = selectedIndexFor(prizeId);
    const segmentAngle = 360 / segmentData.length;
    const center = index * segmentAngle + segmentAngle / 2;
    const current = normalizeDeg(currentRotation);
    const targetMod = normalizeDeg(-center);
    const delta = normalizeDeg(targetMod - current);
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const turns = reduceMotion ? 1 : 7;
    const duration = reduceMotion ? 900 : 4900;

    currentRotation += turns * 360 + delta;
    wheel.style.transitionDuration = `${duration}ms`;
    wheel.style.transform = `rotate(${currentRotation}deg)`;
    playSpinSound(duration);
    return new Promise(resolve => {
      setTimeout(() => {
        setLabelsUpright(currentRotation);
        resolve();
      }, duration + 120);
    });
  }

  function confetti() {
    const layer = $('confettiLayer');
    layer.replaceChildren();
    const colors = ['#ffea00', '#ff477e', '#7cf6ff', '#b6ff5d', '#ffffff', '#ff8a00'];
    const count = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 18 : 70;
    for (let i = 0; i < count; i++) {
      const piece = document.createElement('i');
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.setProperty('--drift', `${(Math.random() - 0.5) * 190}px`);
      piece.style.setProperty('--delay', `${Math.random() * 0.3}s`);
      piece.style.setProperty('--dur', `${1.5 + Math.random() * 1.7}s`);
      piece.style.background = colors[Math.floor(Math.random() * colors.length)];
      piece.style.transform = `rotate(${Math.random() * 180}deg)`;
      layer.appendChild(piece);
    }
    layer.classList.remove('pop');
    void layer.offsetWidth;
    layer.classList.add('pop');
    setTimeout(() => layer.replaceChildren(), 3500);
  }

  function showResult(data, animate = false) {
    const prize = data.prize || {};
    const ui = prizeUi[prize.id] || { icon: '🎁', defaultName: prize.name || '特典' };
    activeClaim = data.claimId;
    $('resultIcon').textContent = ui.icon;
    $('resultPrize').textContent = prize.name || ui.defaultName;
    $('claimLabel').textContent = `ID: ${(data.claimId || '--------').slice(0, 12)}`;
    $('expiryLabel').textContent = `${formatToday()} 23:59まで`;
    showView('resultView');
    startClock();
    if (animate) {
      confetti();
      playWinSound();
      $('ticket').classList.add('ticket-pop');
      setTimeout(() => $('ticket').classList.remove('ticket-pop'), 900);
    }
  }

  function startClock() {
    clearInterval(clockTimer);
    const tick = () => {
      const d = new Date();
      $('liveClock').textContent = [d.getHours(), d.getMinutes(), d.getSeconds()]
        .map(v => String(v).padStart(2, '0')).join(':');
    };
    tick();
    clockTimer = setInterval(tick, 1000);
  }

  async function onSpin() {
    if (spinning) return;
    spinning = true;
    spinButton.disabled = true;
    spinButton.classList.add('is-spinning');
    spinButton.querySelector('.spin-small').textContent = 'ルーレット回転中…';
    spinButton.querySelector('.spin-main').textContent = 'GO!';

    try {
      // 抽選結果は必ずサーバー側で先に確定。
      const result = await api.spin();
      if (result.state === 'redeemed') {
        showView('doneView');
        return;
      }
      if (result.state !== 'won' || !result.prize) {
        throw new Error('抽選結果を取得できませんでした。');
      }
      await spinTo(result.prize.id);
      showResult(result, true);
    } catch (err) {
      showError(err);
    } finally {
      spinning = false;
      spinButton.classList.remove('is-spinning');
      spinButton.querySelector('.spin-small').textContent = '今日の運だめし！';
      spinButton.querySelector('.spin-main').textContent = 'START!';
    }
  }

  function openConfirm() {
    if (!activeClaim) return;
    confirmModal.hidden = false;
    $('confirmRedeem').focus();
  }

  function closeConfirm() {
    confirmModal.hidden = true;
    redeemButton.focus();
  }

  async function onRedeem() {
    if (!activeClaim) return;
    $('confirmRedeem').disabled = true;
    $('confirmRedeem').textContent = '処理中…';
    try {
      const result = await api.redeem(activeClaim);
      if (result.state !== 'redeemed') throw new Error('使用済み処理に失敗しました。');
      confirmModal.hidden = true;
      clearInterval(clockTimer);
      showView('doneView');
      setConnection('本日の特典は利用済みです', 'done');
    } catch (err) {
      confirmModal.hidden = true;
      showError(err);
    } finally {
      $('confirmRedeem').disabled = false;
      $('confirmRedeem').textContent = '使用済みにする';
    }
  }

  function showError(err) {
    clearInterval(clockTimer);
    $('errorMessage').textContent = err && err.message ? err.message : 'エラーが発生しました。';
    setConnection('接続エラー', 'error');
    showView('errorView');
  }

  async function boot() {
    $('todayLabel').textContent = formatToday();
    buildSegments();
    setLabelsUpright(currentRotation);

    try {
      const info = await api.init();
      $('demoBadge').hidden = !info.demo;
      const name = info.profile && info.profile.displayName ? `${info.profile.displayName}さん、` : '';
      setConnection(info.demo ? 'デモモードで動作中' : `${name}LINE認証OK！`, 'ok');

      const status = await api.status();
      if (status.state === 'available') {
        showView('wheelView');
        spinButton.disabled = false;
      } else if (status.state === 'won') {
        showResult(status, false);
      } else if (status.state === 'redeemed') {
        showView('doneView');
        setConnection('本日の特典は利用済みです', 'done');
      } else {
        throw new Error('利用状態を確認できませんでした。');
      }
    } catch (err) {
      showError(err);
    }
  }

  spinButton.addEventListener('click', onSpin);
  redeemButton.addEventListener('click', openConfirm);
  $('cancelRedeem').addEventListener('click', closeConfirm);
  $('confirmRedeem').addEventListener('click', onRedeem);
  $('retryButton').addEventListener('click', () => window.location.reload());
  confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) closeConfirm(); });

  boot();
})();
