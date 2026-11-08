import Phaser from 'phaser';
import { GAME_W, GAME_H, GROUND_Y, PHYS, STEP_MS, FONT } from '../config';
import { OBJ } from '../data/objectTypes';
import { getLevel, EndlessRun } from '../levels';
import { ENDLESS_BASE, DAILY_BASE } from '../levels/endless';
import { onResize, safeArea } from '../ui/Layout';
import { themeFor, chosenOutfit, themeTextures, releaseThemeTextures, OUTFITS } from '../art/Themes';
import type { LevelData } from '../levels/types';
import { buildLevel, LevelWorld, Prop, Bouncer } from '../objects/LevelBuilder';
import { Ragdoll } from '../objects/Ragdoll';
import { decorateLevel, addShadow, DecorHandle } from '../art/Decor';
import { DamageTracker, rupees } from '../systems/DamageTracker';
import { ReplayRecorder } from '../systems/ReplayRecorder';
import { AudioManager, Sfx } from '../systems/AudioManager';
import { Commentary, Speaker } from '../systems/Commentary';
import { SaveManager } from '../systems/SaveManager';
import { Analytics } from '../systems/Analytics';
import { bus } from '../systems/bus';
import { buzz } from '../systems/Haptics';
import { platform } from '../platform/Platform';

type State = 'intro' | 'aim' | 'flight' | 'between' | 'offer' | 'ending' | 'replay' | 'done';

export interface ResultData {
  levelId: number; name: string; starFlags?: [boolean, boolean, boolean]; unlock?: string; daily?: { date: number; launches: number; streak: number; best: boolean }; run?: EndlessRun | null; recordRun?: boolean; cleared: boolean; stars: number; damage: number; score: number; launchesLeft: number;
  gift: boolean; newBest: boolean; badge: string | null; target: number; hasGift: boolean;
}

const POP_LINES = ['DHAMAKA!', 'Arre bhai!', 'Bas karo!', 'Oye hoye!', 'Kya baat!', 'Hatt ja!'];

export class GameScene extends Phaser.Scene {
  level!: LevelData;
  world!: LevelWorld;
  ragdoll: Ragdoll | null = null;
  state: State = 'intro';
  launchesLeft = PHYS.launchesPerLevel;
  launchIndex = -1;
  damage = new DamageTracker();
  recorder = new ReplayRecorder();
  private best: { frames: Float32Array[]; win: { start: number; end: number }; score: number } | null = null;
  physTime = 0;
  private acc = 0;
  private hitStopMs = 0;
  private flightMs = 0;
  private stillMs = 0;
  private stageStillMs = 0;
  private flailUsed = false;
  private whistled = false;
  private stuck = false;
  private aim = { active: false, sx: 0, sy: 0, angle: 45, power: 0, valid: false };
  private lastAim = { angle: 40, power: 0.75 };
  private cannonPivot = new Phaser.Math.Vector2();
  private barrel!: Phaser.GameObjects.Image;
  private peek!: Phaser.GameObjects.Container;
  private traj!: Phaser.GameObjects.Graphics;
  private fitZoom = 1;
  private flightZoom = 1;
  private cam = { x: 0, y: 0, zoom: 1 };
  private camTween: Phaser.Tweens.Tween | null = null;
  private tutorial = false;
  private smoke!: Phaser.GameObjects.Particles.ParticleEmitter;
  private petals!: Phaser.GameObjects.Particles.ParticleEmitter;
  private confetti!: Phaser.GameObjects.Particles.ParticleEmitter;
  private frosting!: Phaser.GameObjects.Particles.ParticleEmitter;
  private sparks!: Phaser.GameObjects.Particles.ParticleEmitter;
  private replayImgs: Record<string, Phaser.GameObjects.Image> = {};
  private replay = { t: 0, start: 0, end: 0, onDone: (() => {}) as () => void };
  private whooshCooldown = 0;
  /** automated tests: physics steps per frame regardless of real time */
  testSteps = 0;
  private hudHandlers: [string, (...a: unknown[]) => void][] = [];

  constructor() {
    super({
      key: 'Game',
      physics: {
        default: 'matter',
        matter: {
          gravity: { x: 0, y: PHYS.gravityY },
          autoUpdate: false,
          enableSleeping: true,
          positionIterations: PHYS.positionIterations,
          velocityIterations: PHYS.velocityIterations,
          debug: false,
        },
      },
    });
  }

  run: EndlessRun | null = null;

  init(data: { levelId?: number; run?: EndlessRun | null }) {
    this.run = (data.levelId ?? 1) >= ENDLESS_BASE && data.run ? { ...data.run } : null;
    this.level = getLevel(data.levelId ?? 1, this.run);
    this.state = 'intro';
    this.launchesLeft = PHYS.launchesPerLevel;
    this.launchIndex = -1;
    this.damage = new DamageTracker();
    this.recorder = new ReplayRecorder();
    this.best = null;
    this.physTime = 0; this.acc = 0; this.hitStopMs = 0;
    this.ragdoll = null;
    this.aim.active = false;
    this.camTween = null;
    this.tutorial = false;
    this.replayImgs = {};
    this.stuck = false;
    this.extraUsed = false;
  }

  create() {
    const L = this.level;
    (window as unknown as { __hcScene: GameScene }).__hcScene = this;
    this.cameras.main.setBackgroundColor('#0e1a40');

    // --- backdrop layers ---
    const theme = themeFor(L.id);
    const tk = themeTextures(this, theme);
    Ragdoll.outfit = chosenOutfit(L.id, SaveManager.data.outfit, SaveManager.totalStars(), (i) => SaveManager.level(i).cleared).id;
    const sky = this.add.image(0, 0, tk.sky).setScrollFactor(0).setDepth(-10);
    this.add.tileSprite(-600, GROUND_Y - 290, L.width + 3000, 300, tk.far).setOrigin(0).setScrollFactor(0.2, 0.35).setDepth(-9);
    this.add.tileSprite(-600, GROUND_Y - 320, L.width + 3000, 330, tk.near).setOrigin(0).setScrollFactor(0.5, 0.7).setDepth(-8);
    this.add.tileSprite(-1200, GROUND_Y - 11, L.width + 2400, 120, tk.ground).setOrigin(0).setDepth(2);
    this.add.rectangle(-3000, GROUND_Y + 108, L.width + 6000, 6000, 0x245e2a).setOrigin(0).setDepth(2);
    // red carpet from cannon to stage
    const carpet = this.add.graphics().setDepth(3);
    carpet.fillStyle(theme.carpet, 1);
    carpet.fillRect(L.cannon.x + 60, GROUND_Y + 14, L.stage.x - L.cannon.x - 40, 16);
    carpet.fillStyle(0xf4c430, 1);
    carpet.fillRect(L.cannon.x + 60, GROUND_Y + 14, L.stage.x - L.cannon.x - 40, 3);

    // sky must cover the view even fully zoomed out
    this.sky = sky;
    this.world = buildLevel(this, L);
    this.decor = decorateLevel(this, L, theme);
    // 2.5D: soft shadows under Lucky and the people
    this.luckyShadow = addShadow(this, 70).setVisible(false);
    this.propShadows = [];
    if (!SaveManager.data.lowfx) for (const p of this.world.props) {
      if (p.type === 'photographer' || p.type === 'relative') this.propShadows.push({ img: addShadow(this, 64), prop: p });
      else if (p.type === 'sofa') addShadow(this, 190).setPosition(p.img.x, GROUND_Y + 1);
      else if (p.type === 'cake' && p.img.y > GROUND_Y - 40) addShadow(this, 170).setPosition(p.img.x, GROUND_Y + 1);
    }

    // --- cannon ---
    const cx = L.cannon.x;
    this.cannonPivot.set(cx + 4, GROUND_Y - 58);
    this.barrel = this.add.image(this.cannonPivot.x, this.cannonPivot.y, 'cannon_barrel').setOrigin(26 / 136, 0.5).setDepth(31);
    this.add.image(cx, GROUND_Y - 36, 'cannon_base').setDepth(32);
    const peekHead = this.add.image(0, 0, 'head_calm');
    const peekPagdi = this.add.image(0, -17, `pagdi_${Ragdoll.outfit}`);
    this.peek = this.add.container(0, 0, [peekHead, peekPagdi]).setDepth(30);
    this.traj = this.add.graphics().setDepth(60);
    this.setBarrelAngle(this.lastAim.angle);

    // --- effects ---
    this.smoke = this.add.particles(0, 0, 'px_smoke', { lifespan: 900, speed: { min: 40, max: 200 }, scale: { start: 0.9, end: 2.4 }, alpha: { start: 0.8, end: 0 }, emitting: false }).setDepth(70);
    this.petals = this.add.particles(0, 0, 'px_petal', { lifespan: 1100, speed: { min: 80, max: 260 }, gravityY: 400, rotate: { min: 0, max: 360 }, scale: { min: 0.7, max: 1.3 }, emitting: false, tint: [0xf7a21b, 0xf4c430, 0xe6197e] }).setDepth(71);
    this.confetti = this.add.particles(0, 0, 'px_confetti', { lifespan: 2400, speed: { min: 200, max: 600 }, angle: { min: 220, max: 320 }, gravityY: 500, rotate: { min: 0, max: 360 }, emitting: false, tint: [0xf7a21b, 0xe6197e, 0xf4c430, 0x3e9b3a, 0x6ad1ff] }).setDepth(72);
    this.frosting = this.add.particles(0, 0, 'px_frost', { lifespan: 1200, speed: { min: 100, max: 320 }, gravityY: 600, scale: { start: 1.2, end: 0.6 }, emitting: false, tint: [0xfff3d6, 0xf48fb1] }).setDepth(71);
    this.sparks = this.add.particles(0, 0, 'px_glow', { lifespan: 500, speed: { min: 100, max: 400 }, scale: { start: 0.5, end: 0 }, blendMode: 'ADD', emitting: false, tint: [0xffd36b, 0xff7b2e] }).setDepth(71);

    // --- physics events ---
    this.matter.world.on('collisionstart', (ev: Phaser.Physics.Matter.Events.CollisionStartEvent) => this.onCollide(ev));

    // --- input ---
    this.input.mouse?.disableContextMenu();
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => this.onDown(p));
    this.input.on('pointermove', (p: Phaser.Input.Pointer) => this.onMove(p));
    this.input.on('pointerup', (p: Phaser.Input.Pointer) => this.onUp(p));
    this.input.on('pointerupoutside', (p: Phaser.Input.Pointer) => this.onUp(p));
    const kb = this.input.keyboard;
    kb?.on('keydown-SPACE', () => this.skip());
    kb?.on('keydown-R', () => this.restart());
    kb?.on('keydown-ESC', () => this.pauseGame());
    kb?.on('keydown-P', () => this.pauseGame());

    // --- HUD ---
    this.scene.launch('Hud', { levelId: L.id });
    if (this.run) this.time.delayedCall(20, () => bus.emit('hud:run', this.run));
    this.scene.bringToTop('Hud');
    const on = (e: string, fn: (...a: unknown[]) => void) => { bus.on(e, fn); this.hudHandlers.push([e, fn]); };
    on('hud:pause', () => this.pauseGame());
    on('hud:restart', () => this.restart());
    on('offer:accept', () => void this.acceptOffer());
    on('offer:decline', () => this.declineOffer());
    this.events.once('shutdown', () => {
      for (const [e, fn] of this.hudHandlers) bus.off(e, fn);
      this.hudHandlers = [];
      this.tweens.killAll();
      Commentary.stop();
      this.pops = [];
      // free per-level canvases (venue art and level-sized props) so memory stays flat across many levels
      releaseThemeTextures(this, theme);
      for (const k of this.textures.getTextureKeys()) if (/_\d+x\d+$/.test(k)) this.textures.remove(k);
    });
    this.game.events.on('hidden', this.onHidden, this);
    this.events.once('shutdown', () => this.game.events.off('hidden', this.onHidden, this));

    Analytics.track('level_start', { level: L.id });
    platform.gameplayStart();

    // --- intro pan: stage -> cannon ---
    // whole level (cannon to stage) fits on one screen while aiming
    const right = L.stage.x + L.stage.w + 90;
    this.fitZoom = Math.min(1, this.scale.width / right);
    this.flightZoom = Math.min(1, this.fitZoom * 1.45);
    onResize(this, () => {
      this.cameras.main.setSize(this.scale.width, this.scale.height);
      this.fitZoom = Math.min(1, this.scale.width / (L.stage.x + L.stage.w + 90));
      this.flightZoom = Math.min(1, this.fitZoom * 1.45);
      this.applyCamera();
    });
    const stageCx = L.stage.x + L.stage.w / 2;
    this.cam.x = stageCx; this.cam.y = L.stage.y - 120; this.cam.zoom = 1;
    this.applyCamera();
    this.time.delayedCall(10, () => {
      bus.emit('hud:init', { level: L, launches: this.launchesLeft });
      bus.emit('hud:toast', L.name, `${theme.venue} · ${L.tip}`);
      if (L.name.startsWith('BOSS')) { bus.emit('hud:boss'); AudioManager.play('ohh'); }
    });
    this.camTween = this.tweens.add({
      targets: this.cam, x: this.aimCamX(), y: this.aimCamY(), zoom: this.fitZoom, duration: 1300, delay: 500, ease: 'Sine.inOut',
      onComplete: () => this.enterAim(),
    });
  }

  // ---------------- camera ----------------
  private aimCamX() { return (this.level.stage.x + this.level.stage.w + 90) / 2; }
  private aimCamY() { return GAME_H - this.scale.height / 2 / this.fitZoom; }

  private sky!: Phaser.GameObjects.Image;

  private applyCamera() {
    // the sky is screen-fixed: counter the camera zoom so it always just covers the view
    // the sky is screen-fixed: keep it centred and covering the view at any zoom and screen shape
    if (this.sky) this.sky.setPosition(this.scale.width / 2, this.scale.height / 2).setScale((Math.max(this.scale.width / 640, this.scale.height / 360) * 1.05) / this.cam.zoom);
    const c = this.cameras.main;
    const z = this.cam.zoom;
    c.setZoom(z);
    const halfW = this.scale.width / 2 / z, halfH = this.scale.height / 2 / z;
    const w = this.level.width;
    const x = w < halfW * 2 ? w / 2 : Phaser.Math.Clamp(this.cam.x, halfW, w - halfW);
    // very tall (portrait) views show more than the world's height: keep the ground ~70% down the screen
    const y = halfH * 2 > 2300 ? GROUND_Y + halfH * 0.6 - halfH : Phaser.Math.Clamp(this.cam.y, -1600 + halfH, GAME_H - halfH);
    c.centerOn(x, y);
  }

  // ---------------- input ----------------
  private inHudZone(p: Phaser.Input.Pointer) {
    const s = safeArea(this, true); // the HUD sits in the 1280-wide safe area, anchored to the top
    const x = p.x - s.ox, y = p.y - s.oy;
    return y < 96 && (x < 360 || x > GAME_W - 200);
  }

  private onDown(p: Phaser.Input.Pointer) {
    if (this.state === 'intro') { this.skipIntro(); return; }
    if (this.state === 'replay') { this.finishReplay(); return; }
    if (this.state === 'flight') { this.tryFlail(); return; }
    if (this.state !== 'aim') return;
    if (p.rightButtonDown()) { this.cancelAim(); return; }
    if (this.inHudZone(p)) return;
    this.aim.active = true;
    this.aim.sx = p.x; this.aim.sy = p.y;
    this.aim.valid = false;
    if (this.tutorial) { this.tutorial = false; bus.emit('hud:tutorial', false); }
  }

  private onMove(p: Phaser.Input.Pointer) {
    if (!this.aim.active || this.state !== 'aim') return;
    if (p.rightButtonDown()) { this.cancelAim(); return; }
    const vx = this.aim.sx - p.x, vy = this.aim.sy - p.y;
    const len = Math.hypot(vx, vy);
    this.aim.valid = len >= 24;
    if (this.aim.valid) {
      let a = Phaser.Math.RadToDeg(Math.atan2(-vy, vx));
      if (a < -90) a = 80; // dragged forward-down: treat as steep
      this.aim.angle = Phaser.Math.Clamp(a, PHYS.minAngle, PHYS.maxAngle);
      this.aim.power = Phaser.Math.Clamp(len / PHYS.dragForFullPower, 0.12, 1);
      this.setBarrelAngle(this.aim.angle);
    }
    this.drawAim(p);
  }

  private onUp(p: Phaser.Input.Pointer) {
    if (!this.aim.active) return;
    this.onMove(p);
    this.aim.active = false;
    this.traj.clear();
    bus.emit('hud:aim', null);
    bus.emit('hud:power', null);
    if (this.state !== 'aim') return;
    if (!this.aim.valid) { this.cancelAim(); return; }
    this.launch(this.aim.angle, this.aim.power);
  }

  private cancelAim() {
    this.aim.active = false;
    this.traj.clear();
    bus.emit('hud:aim', null);
    bus.emit('hud:power', null);
    this.setBarrelAngle(this.lastAim.angle);
  }

  private skip() {
    if (this.state === 'intro') this.skipIntro();
    else if (this.state === 'replay') this.finishReplay();
  }

  private skipIntro() {
    if (this.camTween) { this.camTween.stop(); this.camTween = null; }
    this.cam.x = this.aimCamX(); this.cam.y = this.aimCamY(); this.cam.zoom = this.fitZoom;
    this.enterAim();
  }

  private setBarrelAngle(deg: number) {
    const r = Phaser.Math.DegToRad(-deg);
    this.barrel.setRotation(r);
    const m = this.muzzle(deg, 92);
    this.peek.setPosition(m.x, m.y).setRotation(r + Math.PI / 2);
  }

  private muzzle(deg: number, dist = 104) {
    const r = Phaser.Math.DegToRad(deg);
    return { x: this.cannonPivot.x + Math.cos(r) * dist, y: this.cannonPivot.y - Math.sin(r) * dist };
  }

  private drawAim(p: Phaser.Input.Pointer) {
    const g = this.traj;
    g.clear();
    bus.emit('hud:aim', { sx: this.aim.sx, sy: this.aim.sy, px: p.x, py: p.y, valid: this.aim.valid, angle: this.aim.angle, power: this.aim.power });
    if (!this.aim.valid) { bus.emit('hud:power', null); return; }
    bus.emit('hud:power', this.aim.power);
    // dotted preview of the first part of the real flight path
    const pts = this.predictPath(this.aim.angle, this.aim.power).filter((_, i) => i % 3 === 0);
    const show = Math.max(8, Math.ceil(pts.length * 0.35));
    for (let i = 0; i < Math.min(show, pts.length); i++) {
      const a = 1 - i / show;
      g.fillStyle(0xffffff, 0.35 + a * 0.6);
      g.fillCircle(pts[i].x, pts[i].y, (3 + a * 4) / Math.max(0.55, this.cam.zoom));
    }
  }

  /**
   * Flight path of Lucky's torso, step by step, using the same integration Matter.js uses
   * (velocity damped by air friction, then gravity, then position += velocity), starting where
   * the torso is spawned. Matches the real flight exactly until he touches something.
   */
  predictPath(angle: number, power: number, maxSteps = 400) {
    const r = Phaser.Math.DegToRad(angle);
    const v = power * PHYS.maxLaunchSpeed;
    let vx = Math.cos(r) * v, vy = -Math.sin(r) * v;
    const m = this.muzzle(angle, 96);
    let x = m.x, y = m.y;
    const gStep = PHYS.gravityY * 0.001 * STEP_MS * STEP_MS;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < maxSteps; i++) {
      vx *= 1 - PHYS.airFriction; vy = vy * (1 - PHYS.airFriction) + gStep;
      x += vx; y += vy;
      pts.push({ x, y });
      if (y > GROUND_Y || x > this.level.width) break;
    }
    return pts;
  }

  // ---------------- flow ----------------
  private enterAim() {
    this.camTween = null;
    this.state = 'aim';
    this.peek.setVisible(true);
    this.setBarrelAngle(this.lastAim.angle);
    if (this.launchIndex < 0 && this.level.id === 1 && !SaveManager.data.tutorialDone && !this.tutorial) this.showTutorial();
  }

  private showTutorial() {
    this.tutorial = true;
    bus.emit('hud:tutorial', true);
  }

  private launch(angle: number, power: number) {
    this.lastAim = { angle, power };
    if (this.tutorial) { this.tutorial = false; bus.emit('hud:tutorial', false); }
    if (!SaveManager.data.tutorialDone) { SaveManager.data.tutorialDone = true; SaveManager.persist(); }
    this.launchesLeft--;
    this.launchIndex++;
    this.damage.newLaunch();
    this.recorder.clear();
    this.flightMs = 0; this.stillMs = 0; this.stageStillMs = 0;
    this.flailUsed = false; this.stuck = false; this.whistled = false;
    if (this.ragdoll) { this.ragdoll.destroy(); this.ragdoll = null; }
    for (const r of this.world.rockets) {
      r.flyTween?.stop();
      r.armed = true;
      r.img.setPosition(r.x, r.y).setAlpha(1).setRotation(Phaser.Math.DegToRad(r.angle + 90));
      r.glow.setVisible(true);
    }
    const rad = Phaser.Math.DegToRad(angle);
    const dir = { x: Math.cos(rad), y: -Math.sin(rad) };
    const m = this.muzzle(angle, 96);
    this.ragdoll = new Ragdoll(this, m.x, m.y, Math.atan2(dir.y, dir.x) + Math.PI / 2);
    const v = power * PHYS.maxLaunchSpeed;
    this.ragdoll.setVelocity(dir.x * v, dir.y * v);
    this.ragdoll.setFace('scared');
    this.ragdoll.sync();
    this.peek.setVisible(false);
    this.setBarrelAngle(angle);
    // juice
    AudioManager.play('boom');
    buzz(20);
    AudioManager.play('slide');
    this.time.delayedCall(120, () => this.react('launch', m.x, m.y - 40, 'aah', true));
    const mz = this.muzzle(angle, 120);
    this.smoke.explode(18, mz.x, mz.y);
    this.sparks.explode(14, mz.x, mz.y);
    this.cameras.main.shake(180, 0.012);
    this.tweens.add({ targets: this.barrel, x: this.cannonPivot.x - dir.x * 14, y: this.cannonPivot.y - dir.y * 14, duration: 70, yoyo: true });
    this.state = 'flight';
    bus.emit('hud:launches', this.launchesLeft);
    Analytics.track('launch', { level: this.level.id, angle: Math.round(angle), power: Math.round(power * 100) });
  }

  private tryFlail() {
    if (this.flailUsed || !this.ragdoll || this.stuck) return;
    this.flailUsed = true;
    this.ragdoll.push(0, -PHYS.flailNudge);
    this.ragdoll.flail();
    AudioManager.play('flail'); AudioManager.play('zip');
    const t = this.ragdoll.torso.position;
    this.petals.explode(8, t.x, t.y);
    this.popText(t.x, t.y - 40, 'Rukooo!', '#ffffff', 26);
    bus.emit('hud:flail');
  }

  private endLaunch() {
    if (this.state !== 'flight' || !this.ragdoll) return;
    const t = this.ragdoll.torso.position;
    const win = !this.stuck && this.world.stageZone.contains(t.x, t.y);
    // keep the best crash for the replay
    const score = this.recorder.score() + (win ? 5 : 0);
    if (this.recorder.frames.length > 10 && (!this.best || score >= this.best.score)) {
      this.best = { frames: this.recorder.frames, win: this.recorder.window(), score };
    }
    this.state = 'between';
    if (win) { this.levelClear(); return; }
    // live commentary on where he ended up
    const S = this.level.stage;
    const missEvent = this.stuck ? 'missVat' : t.x < S.x - 140 ? 'missShort' : t.x > S.x + S.w ? 'missLong' : 'missNear';
    this.time.delayedCall(this.stuck ? 900 : 200, () => this.react(missEvent, t.x, t.y));
    if (this.launchesLeft > 0) this.time.delayedCall(350, () => AudioManager.play('laugh'));
    this.ragdoll.setFace('dizzy');
    if (this.launchesLeft > 0) {
      const msg = this.stuck ? 'Chashni mein phas gaye!' : this.launchesLeft === 1 ? 'Missed! Last launch!' : 'Missed! Try again';
      bus.emit('hud:toast', msg, '');
      this.time.delayedCall(this.testSteps ? 10 : 900, () => {
        if (this.state !== 'between') return;
        this.camTween = this.tweens.add({ targets: this.cam, x: this.aimCamX(), y: this.aimCamY(), zoom: this.fitZoom, duration: this.testSteps ? 10 : 700, ease: 'Sine.inOut', onComplete: () => this.enterAim() });
      });
    } else if (!this.extraUsed && !this.testSteps && platform.hasRewarded()) {
      // out of launches: offer one more for an opt-in rewarded ad (once per attempt)
      this.state = 'offer';
      this.time.delayedCall(700, () => bus.emit('hud:offer'));
    } else {
      this.levelFail();
    }
  }

  private extraUsed = false;

  private async acceptOffer() {
    if (this.state !== 'offer') return;
    this.extraUsed = true;
    Analytics.track('rewarded_offer', { accepted: true });
    const ok = await platform.rewardedBreak();
    if (!this.scene.isActive() || this.state !== 'offer') return;
    if (!ok) {
      // no ad was available (e.g. ads are off during CrazyGames Basic Launch): say so instead of failing silently
      bus.emit('hud:toast', 'No ad available right now', 'Try again later');
      this.time.delayedCall(1400, () => this.levelFail());
      return;
    }
    Analytics.track('rewarded_granted', { level: this.level.id });
    platform.gameplayStart();
    this.launchesLeft = 1;
    this.state = 'between';
    bus.emit('hud:launches', 1);
    bus.emit('hud:toast', 'Bonus launch!', 'One more try');
    this.camTween = this.tweens.add({ targets: this.cam, x: this.aimCamX(), y: this.aimCamY(), zoom: this.fitZoom, duration: 600, ease: 'Sine.inOut', onComplete: () => this.enterAim() });
  }

  private declineOffer() {
    if (this.state !== 'offer') return;
    this.extraUsed = true;
    Analytics.track('rewarded_offer', { accepted: false });
    this.levelFail();
  }

  private levelClear() {
    this.state = 'ending';
    const L = this.level;
    const r = this.ragdoll!;
    r.setFace('happy');
    const gift = !!this.world.gift?.collected;
    const launchesUsed = PHYS.launchesPerLevel - this.launchesLeft;
    // three independent stars: landed, damage target, gift (or a 1-launch clear when there is no gift)
    const starFlags: [boolean, boolean, boolean] = [true, this.damage.total >= L.damageTarget, L.gift ? gift : launchesUsed === 1];
    const stars = starFlags.filter(Boolean).length;
    const score = this.damage.total + 1000 * this.launchesLeft + (gift ? 500 : 0);
    let badge: string | null = null;
    if (this.damage.total < 500) badge = 'Shareef Guest';
    if (this.damage.total >= L.damageTarget * 2) badge = 'Baraat Wrecker';
    if (launchesUsed === 1) badge = badge === 'Baraat Wrecker' ? badge : 'Ek Shot';
    const isDaily = L.id >= DAILY_BASE;
    const newBest = this.run || isDaily ? false : SaveManager.record(L.id, true, stars, score);
    let daily: ResultData['daily'];
    if (isDaily) { const best = SaveManager.recordDaily(L.id - DAILY_BASE, launchesUsed, this.damage.total); daily = { date: L.id - DAILY_BASE, launches: launchesUsed, streak: SaveManager.data.daily.streak, best }; Analytics.track('daily_clear', { launches: launchesUsed }); }
    Analytics.track('level_clear', { level: L.id, stars, damage: this.damage.total, launches_used: launchesUsed });
    if (stars === 3) platform.happyTime();
    let totalBest = 0;
    for (const k in SaveManager.data.levels) totalBest += SaveManager.data.levels[k].best;
    platform.sendScore(this.run ? this.run.damage + this.damage.total : totalBest);
    AudioManager.play('shehnai');
    const t = r.torso.position;
    this.confetti.explode(90, t.x, t.y - 40);
    this.time.delayedCall(250, () => this.confetti.explode(60, L.stage.x + L.stage.w / 2, L.stage.y - 150));
    this.popText(t.x, t.y - 90, 'PAHUNCH GAYE!', '#f4c430', 46);
    AudioManager.play('yay');
    buzz([40, 60, 80]);
    this.decor.cheer();
    this.react('win', t.x, t.y);
    const run = this.run ? { ...this.run, damage: this.run.damage + this.damage.total } : null;
    if (run) { SaveManager.recordEndless(run.round, run.damage); Analytics.track('endless_round_clear', { round: run.round }); }
    const unlock = !run ? OUTFITS.find((o) => o.level === L.id)?.name : undefined;
    const data: ResultData = { levelId: L.id, name: L.name, starFlags, unlock, daily, run, cleared: true, stars, damage: this.damage.total, score, launchesLeft: this.launchesLeft, gift, newBest, badge, target: L.damageTarget, hasGift: !!L.gift };
    this.time.delayedCall(this.testSteps ? 10 : 1300, () => this.startReplay(() => this.showResult(data)));
  }

  private levelFail() {
    this.state = 'ending';
    const L = this.level;
    if (!this.run && L.id < DAILY_BASE) SaveManager.record(L.id, false, 0, 0);
    Analytics.track('level_fail', { level: L.id, damage: this.damage.total });
    AudioManager.play('sad');
    AudioManager.play('fallscream');
    this.time.delayedCall(700, () => this.react('fail', 0, 0));
    bus.emit('hud:toast', 'Shaadi miss ho gayi!', 'Out of launches');
    const run = this.run ? { ...this.run, damage: this.run.damage + this.damage.total } : null;
    let recordRun = false;
    if (run) { recordRun = SaveManager.recordEndless(run.round - 1, run.damage); Analytics.track('endless_over', { round: run.round, damage: run.damage }); }
    const daily = L.id >= DAILY_BASE ? { date: L.id - DAILY_BASE, launches: 3, streak: SaveManager.data.daily.streak, best: false } : undefined;
    const data: ResultData = { levelId: L.id, name: L.name, daily, run, recordRun, cleared: false, stars: 0, damage: this.damage.total, score: 0, launchesLeft: 0, gift: !!this.world.gift?.collected, newBest: false, badge: null, target: L.damageTarget, hasGift: !!L.gift };
    this.time.delayedCall(this.testSteps ? 10 : 1400, () => this.startReplay(() => this.showResult(data)));
  }

  private showResult(data: ResultData) {
    this.state = 'done';
    platform.gameplayStop();
    bus.emit('hud:hide');
    (window as unknown as { __hcResult: ResultData }).__hcResult = data;
    this.scene.launch('Result', data);
    this.scene.bringToTop('Result');
  }

  restart() {
    if (this.scene.isActive('Result') || this.scene.isActive('Pause')) return;
    Analytics.track('retry', { level: this.level.id });
    this.scene.restart({ levelId: this.level.id, run: this.run });
  }

  private pauseGame() {
    if (!this.scene.isActive('Game') || this.state === 'done' || this.state === 'ending' || this.state === 'replay' || this.state === 'offer') return;
    this.aim.active = false; this.traj.clear(); bus.emit('hud:aim', null);
    platform.gameplayStop();
    this.scene.pause();
    this.scene.launch('Pause', { levelId: this.level.id, run: this.run, name: this.level.name });
    this.scene.bringToTop('Pause');
  }

  private onHidden() {
    if (this.scene.isActive() && (this.state === 'aim' || this.state === 'flight' || this.state === 'between')) this.pauseGame();
  }

  // ---------------- replay ----------------
  private startReplay(onDone: () => void) {
    if (!this.best || this.testSteps) { onDone(); return; }
    this.state = 'replay';
    AudioManager.duck(true);
    const keys = Ragdoll.partKeys();
    const texs = Ragdoll.partTextures();
    if (this.ragdoll) for (const k in this.ragdoll.images) this.ragdoll.images[k].setVisible(false);
    keys.forEach((k, i) => {
      const tex = k === 'head' ? 'head_scared' : texs[i];
      this.replayImgs[k] = this.add.image(0, 0, tex).setDepth(40 + i);
      if (k === 'pagdi') this.replayImgs[k].setOrigin(0.5, 0.62);
    });
    this.replay = { t: this.best.win.start, start: this.best.win.start, end: this.best.win.end, onDone };
    bus.emit('hud:replay', this.damage.total);
    this.applyReplayFrame(this.replay.t);
  }

  private applyReplayFrame(t: number) {
    const frames = this.best!.frames;
    const i = Math.floor(t);
    const f = t - i;
    const a = frames[Math.min(i, frames.length - 1)];
    const b = frames[Math.min(i + 1, frames.length - 1)];
    const keys = Ragdoll.partKeys();
    const lerpAngle = (x: number, y: number) => x + Phaser.Math.Angle.Wrap(y - x) * f;
    keys.forEach((k, n) => {
      const o = n * 3;
      this.replayImgs[k].setPosition(a[o] + (b[o] - a[o]) * f, a[o + 1] + (b[o + 1] - a[o + 1]) * f).setRotation(lerpAngle(a[o + 2], b[o + 2]));
    });
    let o = keys.length * 3;
    for (const img of this.world.movables) {
      if (o + 2 < a.length) img.setPosition(a[o] + (b[o] - a[o]) * f, a[o + 1] + (b[o + 1] - a[o + 1]) * f).setRotation(lerpAngle(a[o + 2], b[o + 2]));
      o += 3;
    }
    const torso = this.replayImgs.torso;
    this.cam.x += (torso.x - this.cam.x) * 0.15;
    this.cam.y += (torso.y - this.cam.y) * 0.15;
    this.cam.zoom += (Math.min(1.15, this.flightZoom * 1.2) - this.cam.zoom) * 0.08;
    this.applyCamera();
  }

  private finishReplay() {
    if (this.state !== 'replay') return;
    this.state = 'ending';
    AudioManager.duck(false);
    bus.emit('hud:replayEnd');
    this.replay.onDone();
  }

  // ---------------- physics ----------------
  update(_time: number, delta: number) {
    const dt = Math.min(delta, 100);
    // decorative motion
    for (const f of this.world.fans) f.blades.rotation += dt * 0.02;
    this.whooshCooldown -= dt;

    if (this.state === 'replay') {
      this.replay.t += (dt / STEP_MS) * 0.35;
      if (this.replay.t >= this.replay.end) { this.applyReplayFrame(this.replay.end); this.finishReplay(); return; }
      this.applyReplayFrame(this.replay.t);
      return;
    }

    let steps = 0;
    if (this.testSteps > 0) {
      for (let i = 0; i < this.testSteps; i++) { this.stepOnce(); }
    } else {
      if (this.hitStopMs > 0) { this.hitStopMs -= dt; }
      else {
        this.acc += dt;
        while (this.acc >= STEP_MS && steps < 5) { this.stepOnce(); this.acc -= STEP_MS; steps++; }
        if (steps >= 5) this.acc = 0;
      }
    }
    this.syncVisuals();
    this.updateCamera(dt);
  }

  private stepOnce() {
    if (this.state === 'done' || this.state === 'ending' && !this.ragdoll) return;
    this.physTime += STEP_MS;
    for (const p of this.world.props) p.update?.(STEP_MS, this.physTime);
    const r = this.ragdoll;
    const flying = this.state === 'flight' && r && !this.stuck;
    if (flying) {
      const t = r.torso.position;
      for (const f of this.world.fans) {
        if (f.rect.contains(t.x, t.y)) r.push(f.fx * OBJ.fan.strength, f.fy * OBJ.fan.strength);
      }
    }
    this.matter.world.step(STEP_MS);
    if (!r) return;
    r.capVelocity(PHYS.velocityCap);
    if (this.state !== 'flight') return;
    this.flightMs += STEP_MS;
    const t = r.torso.position;
    if (!this.stuck) {
      // rockets
      for (const rk of this.world.rockets) {
        if (rk.armed && Phaser.Math.Distance.Between(t.x, t.y, rk.x, rk.y) < OBJ.rocket.radius) this.fireRocket(rk);
      }
      // gift
      const g = this.world.gift;
      if (g && !g.collected) {
        for (const b of [r.torso, r.bodies.head]) {
          if (Phaser.Math.Distance.Between(b.position.x, b.position.y, g.x, g.y) < OBJ.gift.radius + 14) { this.collectGift(); break; }
        }
      }
      // hot kadhai oil / tandoor fire: pops Lucky up with a burn (once per launch each)
      for (const h of this.world.hot) {
        if (h.lastLaunch !== this.launchIndex && (h.rect.contains(t.x, t.y) || h.rect.contains(r.bodies.legFront.position.x, r.bodies.legFront.position.y))) this.burn(h);
      }
      // firecrackers explode when touched
      for (const c of this.world.crackers) {
        if (c.live && Phaser.Math.Distance.Between(t.x, t.y, c.x, c.y) < 52) this.explodeCracker(c, 0);
      }
      // chashni vat
      for (const v of this.world.vats) {
        if (v.rect.contains(t.x, t.y)) { this.stickInVat(); break; }
      }
    }
    // cartoon falling whistle when he drops from high up
    if (!this.whistled && !this.stuck && r.torso.velocity.y > 6 && t.y < GROUND_Y - 220) { this.whistled = true; AudioManager.play('fallwhistle'); }
    // whoosh on fast flight
    if (r.torso.speed > 20 && this.whooshCooldown <= 0) { AudioManager.play('whoosh', r.torso.speed / 25); this.whooshCooldown = 700; }
    // record replay frame
    const snap: number[] = [];
    r.snapshot(snap);
    for (const img of this.world.movables) snap.push(img.x, img.y, img.rotation);
    this.recorder.push(snap);
    // settle rule
    const speed = r.torso.speed;
    this.stillMs = speed < PHYS.settleSpeed ? this.stillMs + STEP_MS : 0;
    const onStage = this.world.stageZone.contains(t.x, t.y);
    this.stageStillMs = onStage && speed < 0.9 ? this.stageStillMs + STEP_MS : 0;
    const out = t.x < -150 || t.x > this.level.width + 150 || t.y > GROUND_Y + 300;
    if (this.stuck && this.flightMs > 600) this.endLaunch();
    else if (this.stillMs >= PHYS.settleMs || this.stageStillMs >= 600 || this.flightMs >= PHYS.maxLaunchMs || out) this.endLaunch();
  }

  private decor!: DecorHandle;
  private luckyShadow!: Phaser.GameObjects.Image;
  private propShadows: { img: Phaser.GameObjects.Image; prop: Prop }[] = [];

  private syncVisuals() {
    this.ragdoll?.sync();
    const r = this.ragdoll;
    if (r && !SaveManager.data.lowfx) {
      const t = r.torso.position, S = this.level.stage;
      const surface = t.x > S.x && t.x < S.x + S.w && t.y < S.y + 10 ? S.y : GROUND_Y;
      const k = Phaser.Math.Clamp(1 - (surface - t.y) / 700, 0.2, 1);
      this.luckyShadow.setVisible(true).setPosition(t.x, surface + 1).setDisplaySize(70 * k, 21 * k).setAlpha(0.5 * k);
    } else this.luckyShadow.setVisible(false);
    for (const sh of this.propShadows) {
      const b = sh.prop.body.position;
      const k = Phaser.Math.Clamp(1 - (GROUND_Y - 45 - b.y) / 400, 0.2, 1);
      sh.img.setPosition(sh.prop.img.x, GROUND_Y + 1).setAlpha(0.5 * k);
    }
    for (const p of this.world.props) {
      if (p.movable && !p.body.isStatic) p.img.setPosition(p.body.position.x, p.body.position.y).setRotation(p.body.angle);
    }
  }

  private updateCamera(dt: number) {
    if (this.camTween || this.state === 'intro') { this.applyCamera(); return; }
    const k = 1 - Math.pow(1 - 0.1, dt / STEP_MS);
    if ((this.state === 'flight' || this.state === 'between' || this.state === 'ending') && this.ragdoll) {
      const t = this.ragdoll.torso.position;
      const speed = this.ragdoll.torso.speed;
      const lead = Phaser.Math.Clamp(this.ragdoll.torso.velocity.x * 6, -120, 200);
      this.cam.x += (t.x + lead - this.cam.x) * k;
      this.cam.y += (t.y - this.cam.y) * k;
      const zt = this.flightZoom * (this.state === 'flight' ? 1 - 0.15 * Phaser.Math.Clamp((speed - 10) / 16, 0, 1) : 1);
      this.cam.zoom += (zt - this.cam.zoom) * k * 0.5;
    } else if (this.state === 'aim') {
      this.cam.x += (this.aimCamX() - this.cam.x) * k;
      this.cam.y += (this.aimCamY() - this.cam.y) * k;
      this.cam.zoom += (this.fitZoom - this.cam.zoom) * k;
    }
    this.applyCamera();
  }

  // ---------------- interactions ----------------
  private onCollide(ev: Phaser.Physics.Matter.Events.CollisionStartEvent) {
    const r = this.ragdoll;
    for (const pair of ev.pairs) {
      const a = pair.bodyA.parent, b = pair.bodyB.parent;
      const rel = Math.hypot(a.velocity.x - b.velocity.x, a.velocity.y - b.velocity.y);
      const ra = !!r && r.isPart(a), rb = !!r && r.isPart(b);
      if (ra || rb) {
        if (ra && rb) continue;
        const part = ra ? a : b, other = ra ? b : a;
        if (this.state !== 'flight' || this.stuck) continue;
        const bouncer = this.world.bouncers.get(other.id);
        if (bouncer) this.bounce(bouncer, rel);
        const prop = this.world.bodyProp.get(other.id);
        if (rel > PHYS.shakeSpeed) this.bigImpact(part.position.x, part.position.y, rel, !!prop || !!bouncer);
        if (prop) this.score(prop, rel, part.position);
        else if (rel > 6 && !bouncer) {
          AudioManager.play('crash', rel / 16);
          if (rel > 9) {
            const hard = ['wall', 'pillar', 'arch', 'backdrop', 'block', 'table', 'vatRim'].includes(other.label);
            if (hard) AudioManager.play('bonk');
            this.react(hard ? 'wall' : 'ground', part.position.x, part.position.y, hard ? 'ouch' : 'oof');
          }
        }
      } else if (this.state === 'flight') {
        const pa = this.world.bodyProp.get(a.id), pb = this.world.bodyProp.get(b.id);
        if (!pa && !pb) continue;
        if (pa && (!a.isStatic || pb)) this.score(pa, rel, b.position);
        if (pb && (!b.isStatic || pa)) this.score(pb, rel, a.position);
      }
    }
  }

  private bigImpact(x: number, y: number, rel: number, onProp: boolean) {
    if (rel > 12) buzz(25);
    if (this.whistled) AudioManager.stopChannel('whistle');
    const r = this.ragdoll!;
    this.cameras.main.shake(120, Math.min(0.012, 0.003 + rel * 0.0004));
    this.petals.explode(Math.min(14, 4 + Math.round(rel / 2)), x, y);
    if (rel > PHYS.hitStopSpeed && onProp) this.hitStopMs = 60;
    if (rel > 9 && r.loseTurban()) {
      this.react('turban', x, y);
      AudioManager.play('laugh');
      this.recorder.mark(2);
    }
    this.recorder.mark(rel / 6);
  }

  private bounce(b: Bouncer, rel: number) {
    const r = this.ragdoll!;
    const cooldown = b.kind === 'dhol' ? OBJ.dhol.cooldownMs : OBJ.canopy.cooldownMs;
    if (this.physTime - b.lastMs < cooldown) return;
    b.lastMs = this.physTime;
    const v = r.averageVelocity();
    const vy = -Math.min(22, b.speed + Math.abs(v.y) * 0.25);
    const vx = Phaser.Math.Clamp(v.x * 0.85, -16, 16) + (Math.abs(v.x) < 2 ? 2 : 0);
    r.setVelocity(vx, vy);
    AudioManager.play(b.kind === 'dhol' ? 'dhol' : 'bounce'); AudioManager.play('boing');
    this.tweens.add({ targets: b.img, scaleY: 0.78, scaleX: 1.12, duration: 70, yoyo: true, ease: 'Quad.out' });
    this.petals.explode(10, b.body.position.x, b.body.position.y - 30);
    this.recorder.mark(3);
    if (b.kind === 'dhol') this.popText(b.body.position.x, b.body.position.y - 70, 'DHUM!', '#ffd36b', 30);
    this.react(b.kind, r.torso.position.x, r.torso.position.y);
    // the hit itself always scores, even at low speed
    this.score(b.prop, Math.max(rel, b.prop.hitSpeed + 0.1), r.torso.position);
  }

  private score(prop: Prop, impact: number, from: { x: number; y: number }) {
    if (this.state !== 'flight') return;
    if (impact < prop.hitSpeed) return;
    if (prop.scoredLaunch === this.launchIndex) return;
    prop.scoredLaunch = this.launchIndex;
    prop.onHit?.(impact, from);
    const res = this.damage.hit(prop.value, this.physTime);
    const x = prop.body.position.x, y = prop.body.position.y;
    this.popText(x, y - 40, `+${rupees(res.value)}`, prop.value >= 800 ? '#ffd36b' : '#ffffff', prop.value >= 800 ? 30 : 20);
    AudioManager.play(prop.sound, impact / 12);
    this.recorder.mark(prop.value / 250 + impact / 8);
    if (prop.type === 'photographer') {
      this.hitStopMs = Math.max(this.hitStopMs, OBJ.photographer.flashFreezeMs);
      bus.emit('hud:flash');
      this.react('photographer', x, y - 60, 'ouch', true);
    } else if (prop.type === 'relative') {
      const aunty = prop.name === 'Aunty';
      this.react(aunty ? 'aunty' : 'uncle', x, y - 60, aunty ? 'haaye' : 'arre', true);
      AudioManager.play('ohh');
      this.time.delayedCall(500, () => AudioManager.play('laugh'));
    } else if (prop.type === 'cake') {
      this.frosting.explode(24, x, y);
      this.react('cake', from.x, from.y, 'yay');
    } else if (prop.type === 'sofa' || prop.type === 'laddoo') {
      if (this.ragdoll && Math.hypot(from.x - this.ragdoll.torso.position.x, from.y - this.ragdoll.torso.position.y) < 80) this.react(prop.type, from.x, from.y, prop.type === 'sofa' ? 'oof' : undefined);
    }
    if (res.chain >= 2) {
      const big = res.mult >= PHYS.comboMax;
      bus.emit('hud:combo', res.mult, big);
      AudioManager.play('combo', 1 + res.chain * 0.08);
      if (big && res.chain === 5) { AudioManager.play('ohh'); this.popText(x, y - 130, Phaser.Utils.Array.GetRandom(POP_LINES), '#ff4d6d', 40); this.react('combo', x, y); }
    }
    bus.emit('hud:damage', this.damage.total, res.value);
  }

  private fireRocket(rk: { x: number; y: number; angle: number; img: Phaser.GameObjects.Image; glow: Phaser.GameObjects.Image; armed: boolean; flyTween?: Phaser.Tweens.Tween }) {
    rk.armed = false;
    const r = this.ragdoll!;
    const rad = Phaser.Math.DegToRad(rk.angle);
    r.setVelocity(Math.cos(rad) * OBJ.rocket.boostSpeed, Math.sin(rad) * OBJ.rocket.boostSpeed);
    r.flail();
    AudioManager.play('whistle');
    this.sparks.explode(30, rk.x, rk.y);
    this.smoke.explode(8, rk.x, rk.y);
    rk.glow.setVisible(false);
    rk.flyTween = this.tweens.add({ targets: rk.img, x: rk.x + Math.cos(rad) * 900, y: rk.y + Math.sin(rad) * 900, alpha: 0, duration: 900 });
    const res = this.damage.hit(OBJ.rocket.damage, this.physTime);
    bus.emit('hud:damage', this.damage.total, res.value);
    if (res.chain >= 2) bus.emit('hud:combo', res.mult, res.mult >= PHYS.comboMax);
    this.popText(rk.x, rk.y - 60, 'PATAKHA!', '#ff9a3c', 34);
    this.react('rocket', rk.x, rk.y, 'yay', true);
    this.cameras.main.shake(200, 0.01);
    this.recorder.mark(6);
  }

  private collectGift() {
    const g = this.world.gift!;
    g.collected = true;
    AudioManager.play('gift');
    this.sparks.explode(20, g.x, g.y);
    this.tweens.killTweensOf(g.img);
    g.glow.setVisible(false);
    this.tweens.add({ targets: g.img, y: g.y - 80, scale: 1.6, alpha: 0, duration: 600, ease: 'Back.in' });
    this.react('gift', g.x, g.y, undefined, true);
    bus.emit('hud:gift');
    this.recorder.mark(4);
  }

  private burn(h: { kind: 'kadhai' | 'fire'; x: number; y: number; lastLaunch: number; img: Phaser.GameObjects.Image }) {
    const r = this.ragdoll!;
    h.lastLaunch = this.launchIndex;
    const v = r.averageVelocity();
    r.setVelocity(Phaser.Math.Clamp(v.x * 0.7, -10, 10) + 2, -15);
    r.flail();
    r.setFace('scared');
    for (const k in r.images) r.images[k].setTint(0x8a6a5a);
    this.time.delayedCall(1200, () => { if (this.ragdoll === r) for (const k in r.images) r.images[k].clearTint(); });
    AudioManager.play('sizzle');
    buzz([30, 40, 30]);
    this.smoke.explode(10, h.x, h.y);
    this.sparks.explode(14, h.x, h.y);
    this.tweens.add({ targets: h.img, scaleX: 1.08, scaleY: 0.92, duration: 80, yoyo: true });
    const res = this.damage.hit(-200, this.physTime);
    bus.emit('hud:damage', this.damage.total, res.value);
    this.popText(h.x, h.y - 50, h.kind === 'kadhai' ? 'Garam tel! -₹200' : 'Aag! -₹200', '#ff9a3c', 28);
    this.react(h.kind === 'kadhai' ? 'kadhai' : 'fire', r.torso.position.x, r.torso.position.y, 'burn', true);
    this.time.delayedCall(700, () => AudioManager.play('laugh'));
    this.recorder.mark(4);
  }

  private explodeCracker(c: { x: number; y: number; img: Phaser.GameObjects.Image; spark: Phaser.GameObjects.Particles.ParticleEmitter; live: boolean }, depth: number) {
    if (!c.live) return;
    c.live = false;
    c.img.setVisible(false);
    c.spark.stop();
    AudioManager.play('blast');
    buzz(60);
    AudioManager.play('aah');
    this.sparks.explode(36, c.x, c.y - 20);
    this.confetti.explode(16, c.x, c.y - 20);
    this.smoke.explode(10, c.x, c.y);
    this.cameras.main.shake(220, 0.014);
    const r = this.ragdoll;
    if (r && this.state === 'flight' && !this.stuck) {
      const t = r.torso.position;
      const d = Phaser.Math.Distance.Between(t.x, t.y, c.x, c.y);
      if (d < 150) {
        const dx = Math.sign(t.x - c.x) || 1;
        r.setVelocity(dx * 7 + r.torso.velocity.x * 0.4, -17);
        r.flail();
        if (depth === 0) this.react('cracker', t.x, t.y, 'aah', true);
      }
      const res = this.damage.hit(600, this.physTime);
      bus.emit('hud:damage', this.damage.total, res.value);
      if (res.chain >= 2) bus.emit('hud:combo', res.mult, res.mult >= PHYS.comboMax);
    }
    this.popText(c.x, c.y - 60, 'BOOM!', '#ff4d6d', 34);
    this.recorder.mark(6);
    // chain reaction
    for (const o of this.world.crackers) {
      if (o.live && Phaser.Math.Distance.Between(o.x, o.y, c.x, c.y) < 190) this.time.delayedCall(160, () => this.explodeCracker(o, depth + 1));
    }
  }

  private stickInVat() {
    const r = this.ragdoll!;
    this.stuck = true;
    r.freeze();
    r.setFace('dizzy');
    AudioManager.play('splat');
    const t = r.torso.position;
    this.frosting.explode(18, t.x, t.y);
    const res = this.damage.hit(OBJ.vat.damage, this.physTime);
    bus.emit('hud:damage', this.damage.total, res.value);
    this.popText(t.x, t.y - 70, `Sticky! ${rupees(OBJ.vat.damage).replace('₹-', '-₹')}`, '#ffb347', 30);
    this.react('vat', t.x, t.y - 40, 'burn', true);
    this.time.delayedCall(800, () => AudioManager.play('laugh'));
    this.recorder.mark(3);
  }

  private lastReactAt = -1e9;

  /** Character reaction / host commentary: optional vocal sound, speech bubble or LIVE ticker, spoken line. */
  private react(event: string, x: number, y: number, sfx?: Sfx, force = false) {
    if (this.testSteps) return;
    if (sfx) AudioManager.play(sfx);
    const now = this.time.now;
    const r = Commentary.pick(event);
    if (!r) return;
    if (r.who !== 'host' && !force && now - this.lastReactAt < 900) return;
    if (r.who !== 'host') this.lastReactAt = now;
    if (r.who === 'host') bus.emit('hud:live', r.text);
    else this.bubble(x, y, r.text, r.who);
    Commentary.speak(r.who, r.line, r.priority, r.id);
  }

  private bubble(x: number, y: number, text: string, who: Speaker) {
    const fill = who === 'lucky' ? 0xffffff : who === 'photographer' ? 0xd8f0ff : who === 'aunty' ? 0xffd6ec : 0xfff0c8;
    const label = this.add.text(0, 0, text, { fontFamily: FONT, fontSize: '22px', color: '#2a1420', fontStyle: 'bold', align: 'center', wordWrap: { width: 260 } }).setOrigin(0.5);
    const w = label.width + 28, h = label.height + 18;
    const g = this.add.graphics();
    g.fillStyle(0x2a1420, 1); g.fillRoundedRect(-w / 2 - 3, -h / 2 - 3, w + 6, h + 6, 16);
    g.fillTriangle(-10, h / 2, 10, h / 2, -2, h / 2 + 18);
    g.fillStyle(fill, 1); g.fillRoundedRect(-w / 2, -h / 2, w, h, 14);
    g.fillTriangle(-7, h / 2 - 2, 7, h / 2 - 2, -2, h / 2 + 12);
    const s = Math.min(1.8, 1 / this.cam.zoom);
    const c = this.add.container(x, y - 60 * s, [g, label]).setDepth(130).setScale(0.3 * s);
    this.track(c);
    this.tweens.add({ targets: c, scale: s, duration: 180, ease: 'Back.out' });
    this.tweens.add({ targets: c, y: c.y - 30 * s, alpha: 0, delay: 1300, duration: 400, onComplete: () => c.destroy() });
  }

  private pops: Phaser.GameObjects.GameObject[] = [];

  /** Every text object owns a canvas + GPU texture, so cap how many float on screen at once. */
  private track(o: Phaser.GameObjects.GameObject) {
    this.pops.push(o);
    o.once('destroy', () => { const i = this.pops.indexOf(o); if (i >= 0) this.pops.splice(i, 1); });
    while (this.pops.length > 10) this.pops.shift()?.destroy();
  }

  private popText(x: number, y: number, text: string, color: string, size: number) {
    if (this.testSteps) return;
    size = Math.round(size * Math.min(1.8, 1 / this.cam.zoom));
    const t = this.add.text(x, y, text, {
      fontFamily: FONT, fontSize: `${size}px`, color, fontStyle: 'bold', stroke: '#2a1420', strokeThickness: Math.max(4, size / 5),
    }).setOrigin(0.5).setDepth(120).setScale(0.4);
    this.track(t);
    this.tweens.add({ targets: t, scale: 1, duration: 160, ease: 'Back.out' });
    this.tweens.add({ targets: t, y: y - 60, alpha: 0, delay: 500, duration: 600, onComplete: () => t.destroy() });
  }

  // ---------------- test hooks ----------------
  testLaunch(angle: number, power: number) {
    if (this.state === 'intro') this.skipIntro();
    if (this.state !== 'aim') return false;
    this.launch(angle, power);
    return true;
  }
}
