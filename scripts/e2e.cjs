// End-to-end audit: drives the real game in headless Chromium and checks every flow.
// Usage: npm run build:all  &&  node scripts/e2e.cjs
// Needs Playwright with Chromium (npx playwright install chromium).
const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DIST = path.join(__dirname, '..', 'dist');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mp3': 'audio/mpeg', '.json': 'application/json' };
function serve(dir) {
  return new Promise((res) => {
    const s = http.createServer((req, rsp) => {
      const p = path.join(dir, decodeURIComponent(req.url.split('?')[0]).replace(/\/$/, '/index.html'));
      if (!p.startsWith(dir) || !fs.existsSync(p)) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(rsp);
    }).listen(0, () => res({ url: `http://localhost:${s.address().port}/`, close: () => s.close() }));
  });
}

let failures = 0, passes = 0;
const check = (ok, msg) => { if (ok) { passes++; console.log('  ✓ ' + msg); } else { failures++; console.log('  ✗ ' + msg); } };

async function newPage(browser, errs) {
  const p = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  p.on('pageerror', (e) => errs.push('PAGEERROR ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' || /Content Security Policy/i.test(m.text())) errs.push(m.text()); });
  return p;
}
const game = (p, fn, arg) => p.evaluate(fn, arg);
const active = (p, k) => game(p, (k) => window.__hcGame.scene.isActive(k), k);
const until = async (p, fn, arg, ms = 15000) => { try { await p.waitForFunction(fn, arg, { timeout: ms }); return true; } catch { return false; } };

// Finds and fires a winning single shot on the current level (fast-forwarded physics).
async function winLevel(p, id) {
  return game(p, async (id) => {
    const g = window.__hcGame;
    const frame = () => new Promise((r) => requestAnimationFrame(r));
    const angles = [40, 35, 45, 30, 50, 55, 25, 60, 20, 65, 70, 15];
    for (const a of angles) for (let pw = 1; pw >= 0.4; pw -= 0.05) {
      for (const k of ['Result', 'Pause']) if (g.scene.isActive(k)) g.scene.stop(k);
      window.__hcResult = null;
      g.scene.start('Game', { levelId: id });
      await frame(); await frame();
      const s = window.__hcScene;
      s.testSteps = 120;
      s.testLaunch(a, +pw.toFixed(2));
      let n = 0;
      while (s.state === 'flight' && n++ < 400) await frame();
      if (s.state === 'ending' || s.state === 'done') {
        n = 0;
        while (!window.__hcResult && n++ < 200) await frame();
        return { angle: a, power: +pw.toFixed(2), result: window.__hcResult };
      }
    }
    return null;
  }, id);
}

(async () => {
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });

  // ---------------------------------------------------------------- web build
  console.log('\n[web build]');
  const web = await serve(path.join(DIST, 'web'));
  let errs = [];
  let p = await newPage(browser, errs);
  await p.goto(web.url);
  check(await until(p, () => window.__hcGame && window.__hcGame.scene.isActive('Title')), 'boots to the title screen');
  check(await game(p, () => window.__hcGame.textures.exists('pagdi_o5') && window.__hcGame.textures.exists('kadhai')), 'all textures and outfits generated');

  // menus with real clicks
  await p.mouse.click(640, 400);
  check(await until(p, () => window.__hcGame.scene.isActive('LevelSelect')), 'PLAY opens level select');
  check(await game(p, () => window.__hcGame.scene.getScene('LevelSelect').children.list.some((c) => c.text && /of 1002/.test(c.text))), 'level select shows 1002 levels');
  await p.mouse.click(1236, 375); await p.waitForTimeout(300);
  check(await game(p, () => window.__hcGame.scene.getScene('LevelSelect').children.list.some((c) => c.text && /Levels 11–20/.test(c.text))), 'page arrow shows levels 11–20');
  await p.mouse.click(44, 375); await p.waitForTimeout(300);
  await p.mouse.click(185, 270);
  check(await until(p, () => window.__hcGame.scene.isActive('Game') && window.__hcGame.scene.isActive('Hud')), 'level 1 card starts the game with HUD');
  await p.keyboard.press('Space');
  check(await until(p, () => window.__hcScene.state === 'aim'), 'intro can be skipped (Space)');

  // real drag-to-aim launch
  // deliberately weak shot so it misses and the level stays in progress
  await p.mouse.move(640, 400); await p.mouse.down(); await p.mouse.move(600, 420, { steps: 10 }); await p.mouse.up();
  check(await game(p, () => window.__hcScene.state === 'flight' && window.__hcScene.launchesLeft === 2), 'drag and release launches Lucky (3 → 2 launches)');
  await p.mouse.click(640, 300);
  check(await game(p, () => window.__hcScene['flailUsed'] === true), 'mid-air tap uses the flail');
  check(await until(p, () => ['aim', 'between', 'ending', 'replay', 'done'].includes(window.__hcScene.state), null, 20000), 'launch settles within the time limit');

  // cancel aim
  await until(p, () => window.__hcScene.state === 'aim', null, 8000);
  const before = await game(p, () => window.__hcScene.launchesLeft);
  await p.mouse.move(640, 400); await p.mouse.down(); await p.mouse.move(645, 404, { steps: 2 }); await p.mouse.up();
  check(await game(p, (b) => window.__hcScene.launchesLeft === b && window.__hcScene.state === 'aim', before), 'tiny drag cancels without using a launch');

  // pause / resume / restart
  await p.keyboard.press('Escape');
  check(await until(p, () => window.__hcGame.scene.isActive('Pause') && window.__hcGame.scene.isPaused('Game')), 'Esc pauses the game');
  await p.mouse.click(640, 310);
  check(await until(p, () => !window.__hcGame.scene.isActive('Pause') && window.__hcGame.scene.isActive('Game')), 'Resume button resumes');
  await p.keyboard.press('r');
  check(await until(p, () => window.__hcScene.launchIndex === -1 && window.__hcScene.launchesLeft === 3), 'R restarts the level');
  await game(p, () => window.__hcGame.events.emit('hidden'));
  await p.waitForTimeout(100);
  const hidden = await game(p, () => window.__hcGame.scene.isActive('Pause') || window.__hcScene.state === 'intro');
  check(hidden, 'switching tabs pauses the game');
  if (await active(p, 'Pause')) await p.keyboard.press('Escape');

  // clear every level, checking the result screen and saves
  console.log('\n[all 10 levels]');
  for (let id = 1; id <= 10; id++) {
    const w = await winLevel(p, id);
    const r = w && w.result;
    check(!!(r && r.cleared && r.stars >= 1 && r.score > 0), `level ${id} clearable (${w ? `${w.angle}° at ${Math.round(w.power * 100)}%` : 'no winning shot found'})${r ? `, ★${r.stars}, score ${r.score}` : ''}`);
  }
  check(await until(p, () => window.__hcGame.scene.isActive('Result')), 'result screen shows after a clear');
  const starLogic = await game(p, async () => {
    // force each combination and check the result screen lights exactly the earned stars
    const g = window.__hcGame; const f = () => new Promise((r) => requestAnimationFrame(r));
    const out = [];
    for (const flags of [[true, false, true], [true, true, false], [true, false, false]]) {
      if (g.scene.isActive('Result')) g.scene.stop('Result');
      g.scene.start('Result', { levelId: 2, name: 'Test', cleared: true, stars: flags.filter(Boolean).length, starFlags: flags, damage: 500, score: 1500, launchesLeft: 1, gift: flags[2], newBest: false, badge: null, target: 900, hasGift: true });
      for (let i = 0; i < 90; i++) await f();
      const full = g.scene.getScene('Result').children.list.filter((c) => c.texture && c.texture.key === 'star_full').map((c) => Math.round(c.x));
      out.push(JSON.stringify(full.map((x) => x === 510 ? 0 : x === 640 ? 1 : 2)) === JSON.stringify(flags.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)));
    }
    g.scene.stop('Result');
    return out.every(Boolean);
  });
  check(starLogic, 'result screen lights exactly the stars earned (gift star without the damage star, and so on)');
  console.log('\n[generated campaign levels]');
  for (const id of [11, 250, 500, 1002]) {
    const w = await winLevel(p, id);
    const r = w && w.result;
    check(!!(r && r.cleared && r.levelId === id), `level ${id} generated and won with real physics${w ? ` (${w.angle}° at ${Math.round(w.power * 100)}%)` : ''}`);
  }
  const same = await game(p, async () => {
    const g = window.__hcGame; const frame = () => new Promise((r) => requestAnimationFrame(r));
    const snap = async () => { for (const k of ['Result']) if (g.scene.isActive(k)) g.scene.stop(k); g.scene.start('Game', { levelId: 777 }); await frame(); await frame(); return JSON.stringify(window.__hcScene.level); };
    const a = await snap(); const b = await snap(); return a === b;
  });
  check(same, 'a generated level is identical every time it loads (level 777)');
  const boss = await winLevel(p, 50);
  check(!!(boss && boss.result && boss.result.cleared && /^BOSS/.test(boss.result.name)), `boss level 50 generated and won (${boss && boss.result ? boss.result.name : 'not won'})`);
  check(!!(boss && boss.result && boss.result.unlock === 'Bandmaster'), 'clearing level 50 unlocks the Bandmaster outfit');

  console.log('\n[daily challenge]');
  const today = await game(p, () => { const d = new Date(); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); });
  const dw = await winLevel(p, 100000000 + today);
  check(!!(dw && dw.result && dw.result.cleared && dw.result.daily && dw.result.daily.streak >= 1), `today's Daily Challenge generated and won (${dw && dw.result ? dw.result.name : 'not won'})`);
  const dsame = await game(p, async (id) => { const g = window.__hcGame; const f = () => new Promise((r) => requestAnimationFrame(r)); const snap = async () => { if (g.scene.isActive('Result')) g.scene.stop('Result'); g.scene.start('Game', { levelId: id }); await f(); await f(); return JSON.stringify(window.__hcScene.level); }; return (await snap()) === (await snap()); }, 100000000 + today);
  check(dsame, 'the Daily Challenge is the same level every time today');
  const ds = await game(p, () => JSON.parse(localStorage.getItem('hc_wedding_save_v1')).daily);
  check(ds && ds.streak >= 1 && ds.date > 0, `daily streak saved (${ds && ds.streak}-day)`);
  const saved = await game(p, () => JSON.parse(localStorage.getItem('hc_wedding_save_v1') || '{}'));
  check(saved.levels && [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].every((i) => saved.levels[i] && saved.levels[i].cleared), 'progress saved for levels 1–10');

  // endless baraat
  console.log('\n[endless baraat]');
  await game(p, () => { const g = window.__hcGame; for (const k of ['Result', 'Game', 'Hud']) if (g.scene.isActive(k)) g.scene.stop(k); g.scene.start('LevelSelect'); });
  await p.waitForTimeout(400);
  await p.mouse.click(640, 660);
  check(await until(p, () => window.__hcScene && window.__hcScene.run && window.__hcScene.run.round === 1 && window.__hcGame.scene.isActive('Game')), 'Endless button starts round 1 (unlocked after level 3)');
  const seed = await game(p, () => window.__hcScene.run.seed);
  let runDamage = 0;
  for (let round = 1; round <= 6; round++) {
    const w = await game(p, async ({ round, seed, runDamage }) => {
      const g = window.__hcGame; const frame = () => new Promise((r) => requestAnimationFrame(r));
      for (const a of [40, 35, 45, 30, 50, 55, 25, 60, 20, 65, 70]) for (let pw = 1; pw >= 0.3; pw -= 0.05) {
        for (const k of ['Result', 'Pause']) if (g.scene.isActive(k)) g.scene.stop(k);
        window.__hcResult = null;
        g.scene.start('Game', { levelId: 100000 + round, run: { seed, round, damage: runDamage } });
        await frame(); await frame();
        const s = window.__hcScene; s.testSteps = 120; s.testLaunch(a, +pw.toFixed(2));
        let n = 0; while (s.state === 'flight' && n++ < 400) await frame();
        if (s.state === 'ending' || s.state === 'done') { n = 0; while (!window.__hcResult && n++ < 200) await frame(); return { a, pw: +pw.toFixed(2), r: window.__hcResult, name: s.level.name }; }
      }
      return null;
    }, { round, seed, runDamage });
    const r = w && w.r;
    check(!!(r && r.cleared && r.run && r.run.round === round && r.run.damage >= runDamage), `endless round ${round} generated and won with real physics${w ? ` ("${w.name}", ${w.a}° at ${Math.round(w.pw * 100)}%)` : ''}`);
    if (r && r.run) runDamage = r.run.damage;
  }
  const best = await game(p, () => JSON.parse(localStorage.getItem('hc_wedding_save_v1')).endless);
  check(best && best.round >= 6, `best Endless run saved (round ${best && best.round})`);
  // lose a round on purpose: 3 tiny shots end the run
  const over = await game(p, async ({ seed }) => {
    const g = window.__hcGame; const frame = () => new Promise((r) => requestAnimationFrame(r));
    for (const k of ['Result', 'Pause']) if (g.scene.isActive(k)) g.scene.stop(k);
    window.__hcResult = null;
    g.scene.start('Game', { levelId: 100007, run: { seed, round: 7, damage: 1000 } });
    await frame(); await frame();
    const s = window.__hcScene; s.testSteps = 120;
    // fire three tiny shots that cannot reach the stage
    let n = 0;
    while (!window.__hcResult && n++ < 1500) { if (s.state === 'intro' || s.state === 'aim') s.testLaunch(10, 0.12); await frame(); }
    return window.__hcResult;
  }, { seed });
  check(!!(over && !over.cleared && over.run), 'failing a round ends the run (Run Over screen)');
  await p.waitForTimeout(400);
  await p.mouse.click(640, 530);
  check(await until(p, () => window.__hcScene && window.__hcScene.run && window.__hcScene.run.round === 1 && window.__hcScene.run.damage === 0, null, 8000), 'New Run starts again from round 1');

  // wardrobe: suits unlocked by stars, choice saved and worn in game
  console.log('\n[wardrobe]');
  await game(p, () => { const g = window.__hcGame; for (const k of ['Result', 'Game', 'Hud']) if (g.scene.isActive(k)) g.scene.stop(k); g.scene.start('Wardrobe', { from: 'Title' }); });
  await p.waitForTimeout(500);
  check(await active(p, 'Wardrobe'), 'wardrobe opens');
  const totalStars = await game(p, () => Object.values(JSON.parse(localStorage.getItem('hc_wedding_save_v1')).levels).reduce((a, l) => a + l.stars, 0));
  // card 10 = Navy Suit (needs 6 stars), second row
  await p.mouse.click(640 - 4.5 * 126 + 1 * 126, 448); // row 2, 2nd card = Navy Suit (6 stars)
  await p.waitForTimeout(200);
  const chosen = await game(p, () => JSON.parse(localStorage.getItem('hc_wedding_save_v1')).outfit);
  check(totalStars >= 6 ? chosen === 's1' : chosen !== 's1', `suit unlock follows stars (${totalStars} stars → choice "${chosen}")`);
  if (chosen === 's1') {
    await game(p, () => window.__hcGame.scene.start('Game', { levelId: 2 }));
    await p.waitForTimeout(500);
    check(await game(p, () => window.__hcGame.textures.exists('torso_s1') && window.__hcScene && window.__hcScene.children.list.some(function has(c) { return (c.texture && c.texture.key === 'pagdi_s1') || (c.list && c.list.some(has)); })), 'Lucky wears the chosen suit in game');
  }
  await game(p, () => { const d = JSON.parse(localStorage.getItem('hc_wedding_save_v1')); d.outfit = 'auto'; localStorage.setItem('hc_wedding_save_v1', JSON.stringify(d)); });

  // reload: progress survives, level select shows unlocks
  await p.reload();
  await until(p, () => window.__hcGame && window.__hcGame.scene.isActive('Title'));
  await game(p, () => window.__hcGame.scene.getScene('Title').scene.start('LevelSelect'));
  await p.waitForTimeout(300);
  check(await game(p, () => window.__hcGame.scene.isActive('LevelSelect')), 'level select opens after reload');
  const stars = await game(p, () => Object.values(JSON.parse(localStorage.getItem('hc_wedding_save_v1')).levels).reduce((a, l) => a + l.stars, 0));
  check(stars >= 10, `progress survives a reload (${stars} stars)`);

  // tampered save is sanitised
  await game(p, () => localStorage.setItem('hc_wedding_save_v1', JSON.stringify({ v: 1, sfx: 'loud', music: 99, levels: { 1: { stars: 999, best: -5, cleared: 'yes' }, __proto__: { hacked: true } } })));
  await p.reload();
  check(await until(p, () => window.__hcGame && window.__hcGame.scene.isActive('Title')), 'game boots with a tampered save');

  // settings: sliders, voice toggle, reset with confirm
  await game(p, () => { const t = window.__hcGame.scene.getScene('Title'); t.scene.pause(); t.scene.launch('Settings', { from: 'Title' }); });
  await p.waitForTimeout(300);
  await p.mouse.click(495, 345);
  await p.waitForTimeout(100);
  await p.mouse.click(640, 479); await p.waitForTimeout(100); await p.mouse.click(640, 479);
  await p.waitForTimeout(200);
  const afterReset = await game(p, () => JSON.parse(localStorage.getItem('hc_wedding_save_v1')));
  check(afterReset.voice === false, 'voice commentary toggle saves');
  check(afterReset.haptics === true && afterReset.lowfx === false, 'vibration and reduce-effects settings exist with sane defaults');
  check(Object.keys(afterReset.levels).length === 0, 'reset progress (tap twice) clears progress');
  await p.mouse.click(520, 560); // Back (left of About)
  check(await until(p, () => window.__hcGame.scene.isActive('Title')), 'settings Back returns to the title');
  await game(p, () => { const t = window.__hcGame.scene.getScene('Title'); t.scene.pause(); t.scene.launch('Settings', { from: 'Title' }); });
  await p.waitForTimeout(400); await p.mouse.click(760, 560);
  check(await until(p, () => window.__hcGame.scene.isActive('About'), null, 5000), 'Settings → About & Credits opens');
  check(await game(p, () => window.__hcGame.scene.getScene('About').children.list.some((c) => c.text && /Phaser 3 \(MIT/.test(c.text))), 'About screen shows version and licence credits');
  await p.mouse.click(640 + 392, 76);
  check(await until(p, () => !window.__hcGame.scene.isActive('About') && window.__hcGame.scene.isActive('Settings'), null, 5000), 'About ✕ returns to Settings');
  await p.mouse.click(640 + 276, 124);
  await until(p, () => window.__hcGame.scene.isActive('Title'), null, 5000);

  check(errs.length === 0, `no console errors or CSP violations${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
  await p.close(); web.close();

  // ---------------------------------------------------------------- portal builds with mock SDKs
  const portals = [
    { name: 'poki', sdk: /poki-sdk\.js/, mock: `window.__calls=[];const c=(n)=>(...a)=>{window.__calls.push(n);};window.PokiSDK={init:()=>{__calls.push('init');return Promise.resolve()},gameLoadingFinished:c('gameLoadingFinished'),gameplayStart:c('gameplayStart'),gameplayStop:c('gameplayStop'),commercialBreak:(f)=>{__calls.push('commercialBreak');f&&f();return Promise.resolve()},rewardedBreak:(f)=>{__calls.push('rewardedBreak');f&&f();return Promise.resolve(true)}};`,
      expect: ['init', 'gameLoadingFinished', 'gameplayStart', 'gameplayStop', 'commercialBreak', 'rewardedBreak'] },
    { name: 'crazygames', sdk: /crazygames-sdk-v3\.js/, mock: `window.__calls=[];const store={};window.CrazyGames={SDK:{init:()=>{__calls.push('init');return Promise.resolve()},environment:'crazygames',game:{loadingStart:()=>__calls.push('loadingStart'),loadingStop:()=>__calls.push('loadingStop'),gameplayStart:()=>__calls.push('gameplayStart'),gameplayStop:()=>__calls.push('gameplayStop'),happytime:()=>__calls.push('happytime'),settings:{muteAudio:false},addSettingsChangeListener:(f)=>{window.__cgSettings=f;__calls.push('settingsListener')}},ad:{requestAd:(t,cb)=>{__calls.push('requestAd:'+t);if(t==='rewarded'&&window.__noFill){setTimeout(()=>cb.adError&&cb.adError('unfilled'),30);return;}cb.adStarted&&cb.adStarted();setTimeout(()=>cb.adFinished&&cb.adFinished(),50)}},data:{getItem:(k)=>store[k]||null,setItem:(k,v)=>{__calls.push('data.setItem');store[k]=v}}}};`,
      expect: ['init', 'loadingStart', 'loadingStop', 'gameplayStart', 'gameplayStop', 'requestAd:midgame', 'requestAd:rewarded', 'data.setItem', 'settingsListener'] },
    { name: 'youtube', sdk: /game_api\/v1/, mock: `window.__calls=[];let saved='';window.__yt={};window.ytgame={game:{firstFrameReady:()=>__calls.push('firstFrameReady'),gameReady:()=>__calls.push('gameReady'),saveData:(d)=>{__calls.push('saveData');saved=d;return Promise.resolve()},loadData:()=>{__calls.push('loadData');return Promise.resolve(saved)}},engagement:{sendScore:()=>{__calls.push('sendScore');return Promise.resolve()}},system:{isAudioEnabled:()=>true,onAudioEnabledChange:(f)=>{__yt.audio=f},onPause:(f)=>{__yt.pause=f},onResume:(f)=>{__yt.resume=f},getLanguage:()=>Promise.resolve('en')}};`,
      expect: ['loadData', 'firstFrameReady', 'gameReady', 'saveData', 'sendScore'] },
  ];
  for (const portal of portals) {
    console.log(`\n[${portal.name} build]`);
    const srv = await serve(path.join(DIST, portal.name));
    errs = [];
    p = await newPage(browser, errs);
    await p.route(portal.sdk, (route) => route.fulfill({ contentType: 'text/javascript', body: portal.mock }));
    await p.goto(srv.url);
    check(await until(p, () => window.__hcGame && window.__hcGame.scene.isActive('Title')), 'boots with the portal SDK');
    await p.mouse.click(640, 400);
    await until(p, () => window.__hcGame.scene.isActive('LevelSelect'));
    await p.mouse.click(185, 270);
    await until(p, () => window.__hcGame.scene.isActive('Game'));
    await winLevel(p, 1);
    await until(p, () => window.__hcGame.scene.isActive('Result'));
    await p.waitForTimeout(400);
    await p.mouse.click(800, 530); // Next ▶ (triggers the mid-game ad)
    await until(p, () => window.__hcScene && window.__hcScene.level.id === 2 && window.__hcGame.scene.isActive('Game'), null, 8000);
    if (portal.name === 'youtube') {
      await game(p, () => window.__yt.pause && window.__yt.pause());
      check(await game(p, () => window.__hcGame.loop.running === false || window.__hcGame.scene.isActive('Pause')), 'YouTube onPause pauses the game');
      await game(p, () => window.__yt.resume && window.__yt.resume());
    }
    if (portal.name !== 'youtube') {
      // run out of launches for real (no fast-forward) and take the rewarded +1 launch
      await game(p, () => { const g = window.__hcGame; for (const k of ['Result', 'Pause']) if (g.scene.isActive(k)) g.scene.stop(k); g.scene.start('Game', { levelId: 2 }); });
      await p.waitForTimeout(400);
      // first two misses fast-forwarded; the last one in real time so the ad offer can appear
      for (let i = 0; i < 3; i++) {
        await until(p, () => ['intro', 'aim'].includes(window.__hcScene.state), null, 40000);
        await game(p, (last) => { window.__hcScene.testSteps = last ? 0 : 60; window.__hcScene.testLaunch(10, 0.12); }, i === 2);
        await until(p, () => window.__hcScene.state !== 'flight', null, 40000);
      }
      check(await until(p, () => window.__hcScene.state === 'offer', null, 40000), 'out of launches → rewarded "+1 launch" offer appears');
      await p.waitForTimeout(1300); // the offer panel slides in after 0.7 s
      await p.mouse.click(640, 390);
      check(await until(p, () => window.__hcScene.state === 'aim' && window.__hcScene.launchesLeft === 1, null, 30000), 'watching the ad grants one more launch');
      if (portal.name === 'crazygames') {
        // Basic Launch / QA: the SDK has no ad to show. The player must still get the launch, not lose the level.
        await game(p, () => { window.__noFill = true; const g = window.__hcGame; for (const k of ['Result', 'Pause']) if (g.scene.isActive(k)) g.scene.stop(k); g.scene.start('Game', { levelId: 3 }); });
        await p.waitForTimeout(400);
        for (let i = 0; i < 3; i++) {
          await until(p, () => ['intro', 'aim'].includes(window.__hcScene.state), null, 40000);
          await game(p, (last) => { window.__hcScene.testSteps = last ? 0 : 60; window.__hcScene.testLaunch(10, 0.12); }, i === 2);
          await until(p, () => window.__hcScene.state !== 'flight', null, 40000);
        }
        await until(p, () => window.__hcScene.state === 'offer', null, 40000);
        await p.waitForTimeout(1300);
        await p.mouse.click(640, 390);
        check(await until(p, () => window.__hcScene.state === 'aim' && window.__hcScene.launchesLeft === 1, null, 30000), 'no ad available (Basic Launch) → player still gets the bonus launch');
        await game(p, () => { window.__noFill = false; window.__hcGame.scene.start('Game', { levelId: 2 }); });
        await p.waitForTimeout(500);
      }
    }
    if (portal.name === 'youtube') check(await game(p, () => !document.body.classList.contains('need-landscape')), 'YouTube build plays in portrait (no rotate block)');
    check(await game(p, () => { const t = window.__hcGame.scene.getScene('Title'); return !t || !t.children || true; }) && await game(p, () => !document.fullscreenElement), 'portal build does not force full screen');
    const calls = await game(p, () => window.__calls);
    for (const e of portal.expect) check(calls.includes(e), `SDK call: ${e}`);
    check(await game(p, () => window.__hcScene.level.id === 2), 'Next after the ad starts level 2');
    check(errs.length === 0, `no console errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);
    await p.close(); srv.close();
  }

  // ---------------------------------------------------------------- single-file build (opened as a file)
  console.log('\n[single-file build]');
  errs = [];
  p = await newPage(browser, errs);
  await p.goto('file://' + path.join(DIST, 'single', 'index.html'));
  check(await until(p, () => window.__hcGame && window.__hcGame.scene.isActive('Title')), 'opens straight from a file');
  await p.mouse.click(640, 400);
  await until(p, () => window.__hcGame.scene.isActive('LevelSelect'));
  await p.mouse.click(185, 270);
  check(await until(p, () => window.__hcGame.scene.isActive('Game')), 'plays from a file');
  check(errs.length === 0, `no console errors${errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''}`);

  // ---------------------------------------------------------------- responsive / full screen
  console.log('\n[screens and devices]');
  const resp = await serve(path.join(DIST, 'web'));
  for (const [name, w, h, touch] of [['phone landscape 844×390', 844, 390, true], ['tablet 1180×820', 1180, 820, true], ['ultrawide 2560×1080', 2560, 1080, false]]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, isMobile: touch, hasTouch: touch });
    const pg = await ctx.newPage();
    const perr = []; pg.on('pageerror', (e) => perr.push(e.message));
    await pg.goto(resp.url);
    await until(pg, () => window.__hcGame && window.__hcGame.scene.isActive('Title'));
    await pg.waitForTimeout(300);
    const fill = await pg.evaluate(() => { const c = document.querySelector('#game canvas').getBoundingClientRect(); return [Math.round(c.x), Math.round(c.y), Math.round(c.width), Math.round(c.height)]; });
    check(fill[0] === 0 && fill[1] === 0 && fill[2] === w && fill[3] === h && perr.length === 0, `${name}: game fills the whole screen, no black bars (canvas ${fill[2]}×${fill[3]})`);
    await ctx.close();
  }
  {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const pg = await ctx.newPage();
    await pg.goto(resp.url);
    await until(pg, () => window.__hcGame && window.__hcGame.scene.isActive('Title'));
    const prompt = await pg.evaluate(() => getComputedStyle(document.getElementById('rotate')).display !== 'none');
    await pg.setViewportSize({ width: 844, height: 390 });
    await pg.waitForTimeout(900);
    const after = await pg.evaluate(() => { const c = document.querySelector('#game canvas').getBoundingClientRect(); return [Math.round(c.width), Math.round(c.height), getComputedStyle(document.getElementById('rotate')).display]; });
    check(prompt && after[0] === 844 && after[1] === 390 && after[2] === 'none', `phone rotated portrait → landscape refills the screen (${after[0]}×${after[1]})`);
    await ctx.close();
  }
  {
    // ✕ close buttons (1280×720 so the safe area has no offset)
    const pg = await newPage(browser, []);
    await pg.goto(resp.url);
    await until(pg, () => window.__hcGame && window.__hcGame.scene.isActive('Title'));
    await game(pg, () => { const t = window.__hcGame.scene.getScene('Title'); t.scene.pause(); t.scene.launch('Settings', { from: 'Title' }); });
    await pg.waitForTimeout(400); await pg.mouse.click(640 + 276, 124);
    check(await until(pg, () => !window.__hcGame.scene.isActive('Settings') && window.__hcGame.scene.isActive('Title'), null, 5000), 'Settings ✕ closes Settings');
    await game(pg, () => window.__hcGame.scene.getScene('Title').scene.start('Wardrobe', { from: 'Title' }));
    await pg.waitForTimeout(400); await pg.mouse.click(1230, 56);
    check(await until(pg, () => !window.__hcGame.scene.isActive('Wardrobe'), null, 5000), 'Wardrobe ✕ closes the Wardrobe');
    await game(pg, () => { const g = window.__hcGame; for (const k of ['Title', 'Wardrobe']) if (g.scene.isActive(k)) g.scene.stop(k); g.scene.start('Game', { levelId: 1 }); });
    await pg.waitForTimeout(400); await pg.keyboard.press('Space'); await until(pg, () => window.__hcScene.state === 'aim', null, 8000);
    await pg.keyboard.press('Escape'); await until(pg, () => window.__hcGame.scene.isActive('Pause'), null, 5000);
    await pg.waitForTimeout(300); await pg.mouse.click(640 + 226, 159);
    check(await until(pg, () => !window.__hcGame.scene.isActive('Pause') && !window.__hcGame.scene.isPaused('Game'), null, 5000), 'Pause ✕ resumes the game');
    await pg.close();
  }
  resp.close();

  await browser.close();
  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
})();
