// ============================================================
//  POKEBALL SIM — game.js
//  Top-down bouncing battle engine
// ============================================================

// ---- Global State ----
let pokemonData = null;
let typeChart = null;
let gameState = 'menu'; // menu | story | freebattle | battle | gameover
let playerTeam = [];
let storyState = null;
let battleState = null;
let animFrame = null;
let lastTime = 0;

// ---- Constants ----
const ARENA = { x: 0, y: 0, w: 0, h: 0 }; // set on resize
const BALL_RADIUS = 28;
const PROJECTILE_RADIUS = 7;
const TYPE_COLORS = {
  Fire: '#F08030', Water: '#6890F0', Grass: '#78C850',
  Poison: '#A040A0', Normal: '#A8A878', Electric: '#F8D030',
  Ice: '#98D8D8', Fighting: '#C03028', Ground: '#E0C068',
  Rock: '#B8A038', Bug: '#A8B820', Ghost: '#705898',
  Psychic: '#F85888', Dragon: '#7038F8', Steel: '#B8B8D0',
  Fairy: '#EE99AC', Dark: '#705848', Flying: '#A890F0'
};
const STATUS_COLORS = { burn: '#ff4400', leechSeed: '#44ff44', defenseBoost: '#4488ff' };

// ---- Load Data ----
async function loadData() {
  const res = await fetch('./data/pokemon.json');
  const json = await res.json();
  pokemonData = json.pokemon;
  typeChart = json.typeChart;
}

// ---- Utility ----
function randBetween(a, b) { return a + Math.random() * (b - a); }
function randInt(a, b) { return Math.floor(randBetween(a, b + 1)); }
function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }
function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
function lerp(a, b, t) { return a + (b - a) * t; }

function getTypeMultiplier(moveType, defenderTypes) {
  if (!typeChart[moveType]) return 1;
  let mult = 1;
  const chart = typeChart[moveType];
  for (const dt of defenderTypes) {
    if (chart.immuneTo?.includes(dt)) return 0;
    if (chart.weakTo?.includes(dt)) mult *= 2;
    if (chart.resistantTo?.includes(dt)) mult *= 0.5;
  }
  return mult;
}

// ---- Ball Factory ----
function createBall(pokemonDef, x, y, isPlayer) {
  const speedScale = pokemonDef.speed / 60; // normalize around ~60
  const angle = Math.random() * Math.PI * 2;
  const spd = 80 + pokemonDef.speed * 0.8;
  return {
    id: Math.random().toString(36).slice(2),
    def: pokemonDef,
    isPlayer,
    x, y,
    vx: Math.cos(angle) * spd,
    vy: Math.sin(angle) * spd,
    maxHp: pokemonDef.hp * 2.5,   // scale for longer battles
    hp: pokemonDef.hp * 2.5,
    radius: BALL_RADIUS,
    // move cooldowns: array matching def.moves
    moveCooldowns: pokemonDef.moves.map(() => 0),
    // status effects
    statuses: [],
    defMult: 1,
    atkMult: 1,
    // flash animation
    flashTimer: 0,
    flashColor: '#ffffff',
    // label
    name: pokemonDef.name,
    color: pokemonDef.color,
    types: pokemonDef.types,
    // particle burst queue
    particles: [],
    // damage number queue
    damageNumbers: []
  };
}

// ---- Projectile Factory ----
function createProjectile(owner, move, targetBall) {
  const angle = Math.atan2(targetBall.y - owner.y, targetBall.x - owner.x);
  const spd = 220 + move.power * 0.5;
  return {
    id: Math.random().toString(36).slice(2),
    ownerId: owner.id,
    ownerIsPlayer: owner.isPlayer,
    move,
    x: owner.x,
    y: owner.y,
    vx: Math.cos(angle) * spd,
    vy: Math.sin(angle) * spd,
    radius: PROJECTILE_RADIUS,
    color: TYPE_COLORS[move.type] || '#ffffff',
    life: 2.0,  // seconds before auto-expire
    range: move.range
  };
}

// ---- Battle Setup ----
function startBattle(playerBalls, enemyBalls, onBattleEnd) {
  const canvas = document.getElementById('battleCanvas');
  ARENA.x = 30; ARENA.y = 30;
  ARENA.w = canvas.width - 60;
  ARENA.h = canvas.height - 60;

  // place balls
  playerBalls.forEach((b, i) => {
    b.x = ARENA.x + 80 + i * 70;
    b.y = ARENA.y + ARENA.h * 0.3 + randBetween(-40, 40);
    const spd = 80 + b.def.speed * 0.8;
    const a = Math.random() * Math.PI * 2;
    b.vx = Math.cos(a) * spd; b.vy = Math.sin(a) * spd;
  });
  enemyBalls.forEach((b, i) => {
    b.x = ARENA.x + ARENA.w - 80 - i * 70;
    b.y = ARENA.y + ARENA.h * 0.7 + randBetween(-40, 40);
    const spd = 80 + b.def.speed * 0.8;
    const a = Math.random() * Math.PI * 2;
    b.vx = Math.cos(a) * spd; b.vy = Math.sin(a) * spd;
  });

  battleState = {
    playerBalls,
    enemyBalls,
    projectiles: [],
    particles: [],
    damageNumbers: [],
    onBattleEnd,
    battleLog: [],
    time: 0
  };

  gameState = 'battle';
  if (animFrame) cancelAnimationFrame(animFrame);
  lastTime = performance.now();
  animFrame = requestAnimationFrame(gameLoop);
}

// ---- AI: pick a move ----
function aiPickMove(ball, enemies) {
  if (!enemies.length) return;
  const now = battleState.time;
  // find nearest enemy
  let nearest = enemies[0];
  let nearestD = dist(ball, enemies[0]);
  for (const e of enemies) {
    const d = dist(ball, e);
    if (d < nearestD) { nearestD = d; nearest = e; }
  }

  for (let i = 0; i < ball.def.moves.length; i++) {
    if (now < ball.moveCooldowns[i]) continue;
    const move = ball.def.moves[i];
    if (move.category === 'status' && move.effect === 'defenseBoost') {
      // use defensively when low hp
      if (ball.hp / ball.maxHp < 0.5) {
        useMove(ball, i, nearest);
        return;
      }
    } else if (nearestD <= move.range) {
      useMove(ball, i, nearest);
      return;
    }
  }
}

// ---- Use Move ----
function useMove(ball, moveIdx, target) {
  const move = ball.def.moves[moveIdx];
  ball.moveCooldowns[moveIdx] = battleState.time + move.cooldown;

  if (move.category === 'status') {
    if (move.effect === 'defenseBoost') {
      ball.defMult = move.value || 1.5;
      ball.statuses.push({ type: 'defenseBoost', expires: battleState.time + (move.duration || 5000) });
      ball.flashColor = '#4488ff';
      ball.flashTimer = 300;
      addLog(`${ball.name} used ${move.name}!`);
    } else if (move.effect === 'leechSeed') {
      // apply to target
      if (!target.statuses.find(s => s.type === 'leechSeed')) {
        target.statuses.push({ type: 'leechSeed', expires: battleState.time + (move.duration || 5000), source: ball.id });
        target.flashColor = '#44ff44';
        target.flashTimer = 300;
        addLog(`${ball.name} seeded ${target.name}!`);
      }
    }
    return;
  }

  // Ranged attack — spawn projectile
  const proj = createProjectile(ball, move, target);
  battleState.projectiles.push(proj);
  addLog(`${ball.name} used ${move.name}!`);
}

// ---- Apply Damage ----
function applyDamage(attacker, defender, move) {
  // Determine stat category
  const atkStat = move.category === 'special' ? attacker.def.spAttack : attacker.def.attack;
  const defStat = move.category === 'special' ? defender.def.spDefense : defender.def.defense;

  const typeMultiplier = getTypeMultiplier(move.type, defender.types);
  if (typeMultiplier === 0) {
    addDamageNumber(defender, 'Immune!', '#ffffff');
    return;
  }

  // Low HP passive
  let atkBoost = attacker.atkMult;
  const passive = attacker.def.passiveAbility;
  if (passive && passive.trigger === 'lowHp' && attacker.hp / attacker.maxHp < 0.33) {
    atkBoost *= passive.value;
  }

  const dmg = Math.max(1, Math.round(
    ((2 * 5 / 5 + 2) * move.power * (atkStat / defStat) / 50 + 2)
    * typeMultiplier * atkBoost * (defender.defMult < 1 ? defender.defMult : 1 / defender.defMult)
    * randBetween(0.85, 1.0)
  ));

  defender.hp = Math.max(0, defender.hp - dmg);
  defender.flashColor = typeMultiplier >= 2 ? '#ff0000' : '#ffffff';
  defender.flashTimer = 200;

  // Effectiveness label
  let effectLabel = '';
  if (typeMultiplier >= 2) effectLabel = ' SUPER!';
  else if (typeMultiplier <= 0.5) effectLabel = ' resisted';

  addDamageNumber(defender, `-${dmg}${effectLabel}`, typeMultiplier >= 2 ? '#ff4444' : '#ffff88');
  spawnHitParticles(defender.x, defender.y, TYPE_COLORS[move.type] || '#fff');

  // Status chance
  if (move.effect === 'burn' && move.chance && Math.random() < move.chance) {
    if (!defender.statuses.find(s => s.type === 'burn')) {
      defender.statuses.push({ type: 'burn', expires: Infinity });
      addLog(`${defender.name} was burned!`);
    }
  }
}

// ---- Damage Numbers ----
function addDamageNumber(ball, text, color) {
  battleState.damageNumbers.push({
    x: ball.x + randBetween(-20, 20),
    y: ball.y - ball.radius,
    text, color,
    life: 1.2,
    vy: -60
  });
}

function addLog(msg) {
  battleState.battleLog.unshift(msg);
  if (battleState.battleLog.length > 6) battleState.battleLog.pop();
  renderLog();
}

function renderLog() {
  const el = document.getElementById('battleLog');
  if (!el) return;
  el.innerHTML = battleState.battleLog.map((l, i) =>
    `<div style="opacity:${1 - i * 0.15}">${l}</div>`
  ).join('');
}

// ---- Particles ----
function spawnHitParticles(x, y, color) {
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + randBetween(0, 0.5);
    const spd = randBetween(60, 180);
    battleState.particles.push({ x, y, vx: Math.cos(a) * spd, vy: Math.sin(a) * spd, color, life: 0.5, radius: randBetween(3, 7) });
  }
}

// ---- Physics Update ----
function updateBalls(dt, balls) {
  for (const ball of balls) {
    if (ball.hp <= 0) continue;

    // Move
    ball.x += ball.vx * dt;
    ball.y += ball.vy * dt;

    // Wall bounce
    if (ball.x - ball.radius < ARENA.x) { ball.x = ARENA.x + ball.radius; ball.vx = Math.abs(ball.vx); }
    if (ball.x + ball.radius > ARENA.x + ARENA.w) { ball.x = ARENA.x + ARENA.w - ball.radius; ball.vx = -Math.abs(ball.vx); }
    if (ball.y - ball.radius < ARENA.y) { ball.y = ARENA.y + ball.radius; ball.vy = Math.abs(ball.vy); }
    if (ball.y + ball.radius > ARENA.y + ARENA.h) { ball.y = ARENA.y + ARENA.h - ball.radius; ball.vy = -Math.abs(ball.vy); }

    // Flash decay
    if (ball.flashTimer > 0) ball.flashTimer -= dt * 1000;

    // Status tick
    for (let i = ball.statuses.length - 1; i >= 0; i--) {
      const s = ball.statuses[i];
      if (s.expires !== Infinity && battleState.time > s.expires) {
        if (s.type === 'defenseBoost') ball.defMult = 1;
        ball.statuses.splice(i, 1);
        continue;
      }
      if (s.type === 'burn' && battleState.time % 1000 < dt * 1000 + 16) {
        const dmg = Math.max(1, Math.floor(ball.maxHp * 0.06));
        ball.hp = Math.max(0, ball.hp - dmg);
        addDamageNumber(ball, `-${dmg} burn`, '#ff4400');
        ball.flashColor = '#ff4400'; ball.flashTimer = 150;
      }
      if (s.type === 'leechSeed' && battleState.time % 1500 < dt * 1000 + 16) {
        const drain = Math.max(1, Math.floor(ball.maxHp * 0.04));
        ball.hp = Math.max(0, ball.hp - drain);
        addDamageNumber(ball, `-${drain} seed`, '#44ff44');
        // heal source
        const src = [...battleState.playerBalls, ...battleState.enemyBalls].find(b => b.id === s.source);
        if (src && src.hp > 0) { src.hp = Math.min(src.maxHp, src.hp + drain); }
      }
    }
  }
}

function updateBallCollisions(allBalls) {
  for (let i = 0; i < allBalls.length; i++) {
    for (let j = i + 1; j < allBalls.length; j++) {
      const a = allBalls[i], b = allBalls[j];
      if (a.hp <= 0 || b.hp <= 0) continue;
      const d = dist(a, b);
      const minD = a.radius + b.radius;
      if (d < minD && d > 0.01) {
        // Separate
        const overlap = (minD - d) / 2;
        const nx = (b.x - a.x) / d, ny = (b.y - a.y) / d;
        a.x -= nx * overlap; a.y -= ny * overlap;
        b.x += nx * overlap; b.y += ny * overlap;
        // Elastic bounce weighted by defense
        const massA = a.def.defense, massB = b.def.defense;
        const relVx = a.vx - b.vx, relVy = a.vy - b.vy;
        const dot = relVx * nx + relVy * ny;
        if (dot > 0) {
          const imp = (2 * dot) / (massA + massB);
          a.vx -= imp * massB * nx; a.vy -= imp * massB * ny;
          b.vx += imp * massA * nx; b.vy += imp * massA * ny;
        }
        spawnHitParticles((a.x + b.x) / 2, (a.y + b.y) / 2, '#aaaaaa');
      }
    }
  }
}

// ---- Projectile Update ----
function updateProjectiles(dt) {
  const allBalls = [...battleState.playerBalls, ...battleState.enemyBalls];
  for (let i = battleState.projectiles.length - 1; i >= 0; i--) {
    const p = battleState.projectiles[i];
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    p.life -= dt;

    // Check arena bounds
    if (p.x < ARENA.x || p.x > ARENA.x + ARENA.w || p.y < ARENA.y || p.y > ARENA.y + ARENA.h || p.life <= 0) {
      battleState.projectiles.splice(i, 1);
      continue;
    }

    // Hit detection
    let hit = false;
    for (const ball of allBalls) {
      if (ball.id === p.ownerId || ball.hp <= 0) continue;
      if (ball.isPlayer === p.ownerIsPlayer) continue; // same team
      if (dist(p, ball) < ball.radius + p.radius) {
        const owner = allBalls.find(b => b.id === p.ownerId);
        if (owner) applyDamage(owner, ball, p.move);
        spawnHitParticles(p.x, p.y, p.color);
        battleState.projectiles.splice(i, 1);
        hit = true;
        break;
      }
    }
    if (hit) continue;
  }
}

function updateParticles(dt) {
  for (let i = battleState.particles.length - 1; i >= 0; i--) {
    const p = battleState.particles[i];
    p.x += p.vx * dt; p.y += p.vy * dt;
    p.life -= dt;
    if (p.life <= 0) battleState.particles.splice(i, 1);
  }
  for (let i = battleState.damageNumbers.length - 1; i >= 0; i--) {
    const d = battleState.damageNumbers[i];
    d.y += d.vy * dt;
    d.life -= dt;
    if (d.life <= 0) battleState.damageNumbers.splice(i, 1);
  }
}

// ---- AI Tick ----
function updateAI() {
  for (const ball of battleState.enemyBalls) {
    if (ball.hp <= 0) continue;
    const alive = battleState.playerBalls.filter(b => b.hp > 0);
    aiPickMove(ball, alive);
  }
  // Player balls also auto-fight (both sides are AI in auto-battle)
  for (const ball of battleState.playerBalls) {
    if (ball.hp <= 0) continue;
    const alive = battleState.enemyBalls.filter(b => b.hp > 0);
    aiPickMove(ball, alive);
  }
}

// ---- Win Condition ----
function checkBattleEnd() {
  const playerAlive = battleState.playerBalls.filter(b => b.hp > 0).length;
  const enemyAlive = battleState.enemyBalls.filter(b => b.hp > 0).length;
  if (playerAlive === 0) {
    endBattle('lose');
  } else if (enemyAlive === 0) {
    endBattle('win');
  }
}

function endBattle(result) {
  cancelAnimationFrame(animFrame);
  animFrame = null;
  battleState.onBattleEnd(result);
}

// ---- Main Game Loop ----
function gameLoop(timestamp) {
  const dt = Math.min((timestamp - lastTime) / 1000, 0.05);
  lastTime = timestamp;
  battleState.time += dt * 1000;

  updateAI();
  const allBalls = [...battleState.playerBalls, ...battleState.enemyBalls];
  updateBalls(dt, allBalls);
  updateBallCollisions(allBalls);
  updateProjectiles(dt);
  updateParticles(dt);
  checkBattleEnd();
  renderBattle(dt);

  animFrame = requestAnimationFrame(gameLoop);
}

// ---- Render ----
function renderBattle(dt) {
  const canvas = document.getElementById('battleCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  // Background
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, W, H);

  // Arena border + grid
  ctx.strokeStyle = '#1a1a2e';
  ctx.lineWidth = 1;
  const gridSize = 50;
  for (let gx = ARENA.x; gx <= ARENA.x + ARENA.w; gx += gridSize) {
    ctx.beginPath(); ctx.moveTo(gx, ARENA.y); ctx.lineTo(gx, ARENA.y + ARENA.h); ctx.stroke();
  }
  for (let gy = ARENA.y; gy <= ARENA.y + ARENA.h; gy += gridSize) {
    ctx.beginPath(); ctx.moveTo(ARENA.x, gy); ctx.lineTo(ARENA.x + ARENA.w, gy); ctx.stroke();
  }
  // Arena glow border
  ctx.strokeStyle = '#e8001a';
  ctx.lineWidth = 2;
  ctx.strokeRect(ARENA.x, ARENA.y, ARENA.w, ARENA.h);
  // Corner marks
  const cSize = 12;
  ctx.strokeStyle = '#ff4444';
  ctx.lineWidth = 3;
  [[ARENA.x, ARENA.y], [ARENA.x + ARENA.w, ARENA.y], [ARENA.x, ARENA.y + ARENA.h], [ARENA.x + ARENA.w, ARENA.y + ARENA.h]].forEach(([cx, cy]) => {
    const sx = cx === ARENA.x ? 1 : -1, sy = cy === ARENA.y ? 1 : -1;
    ctx.beginPath(); ctx.moveTo(cx, cy + sy * cSize); ctx.lineTo(cx, cy); ctx.lineTo(cx + sx * cSize, cy); ctx.stroke();
  });

  // Particles
  for (const p of battleState.particles) {
    ctx.globalAlpha = p.life * 2;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radius * p.life * 2, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Projectiles
  for (const p of battleState.projectiles) {
    ctx.shadowColor = p.color;
    ctx.shadowBlur = 12;
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI * 2); ctx.fill();
    // Trail
    ctx.globalAlpha = 0.3;
    ctx.beginPath(); ctx.arc(p.x - p.vx * 0.03, p.y - p.vy * 0.03, p.radius * 0.6, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
  }

  // Balls
  const allBalls = [...battleState.playerBalls, ...battleState.enemyBalls];
  for (const ball of allBalls) {
    if (ball.hp <= 0) {
      // Faded dead ball
      ctx.globalAlpha = 0.2;
      ctx.fillStyle = '#444';
      ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
      continue;
    }

    const flash = ball.flashTimer > 0;
    const isLowHp = ball.hp / ball.maxHp < 0.33;

    // Glow
    ctx.shadowColor = flash ? ball.flashColor : ball.color;
    ctx.shadowBlur = flash ? 24 : (isLowHp ? 20 : 10);

    // Ball body
    const grad = ctx.createRadialGradient(ball.x - ball.radius * 0.3, ball.y - ball.radius * 0.3, 2, ball.x, ball.y, ball.radius);
    grad.addColorStop(0, flash ? ball.flashColor : lightenColor(ball.color, 40));
    grad.addColorStop(1, flash ? ball.flashColor : ball.color);
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2); ctx.fill();

    // Second type ring
    if (ball.def.types.length > 1) {
      ctx.strokeStyle = TYPE_COLORS[ball.def.types[1]] || '#fff';
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.radius - 3, 0, Math.PI * 2); ctx.stroke();
    }

    ctx.shadowBlur = 0;

    // Player/enemy indicator ring
    ctx.strokeStyle = ball.isPlayer ? '#00ff88' : '#ff4444';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.arc(ball.x, ball.y, ball.radius + 4, 0, Math.PI * 2); ctx.stroke();

    // Sprite emoji
    ctx.font = `${ball.radius}px serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(ball.def.sprite, ball.x, ball.y);

    // Status icons
    let sxOff = -ball.radius;
    for (const s of ball.statuses) {
      ctx.font = '12px serif';
      ctx.fillText(s.type === 'burn' ? '🔥' : s.type === 'leechSeed' ? '🌿' : '🛡️', ball.x + sxOff, ball.y - ball.radius - 10);
      sxOff += 16;
    }

    // HP Bar
    const barW = ball.radius * 2.2, barH = 5;
    const barX = ball.x - barW / 2, barY = ball.y + ball.radius + 6;
    ctx.fillStyle = '#222';
    ctx.fillRect(barX, barY, barW, barH);
    const hpPct = ball.hp / ball.maxHp;
    ctx.fillStyle = hpPct > 0.5 ? '#44ff44' : hpPct > 0.25 ? '#ffff44' : '#ff4444';
    ctx.fillRect(barX, barY, barW * hpPct, barH);
    ctx.strokeStyle = '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(barX, barY, barW, barH);

    // Name
    ctx.font = '9px "Courier New", monospace';
    ctx.fillStyle = '#ccc';
    ctx.textAlign = 'center';
    ctx.fillText(ball.name, ball.x, barY + barH + 9);
  }

  // Damage numbers
  for (const d of battleState.damageNumbers) {
    ctx.globalAlpha = Math.max(0, d.life);
    ctx.font = `bold ${10 + (1.2 - d.life) * 8}px "Courier New", monospace`;
    ctx.fillStyle = d.color;
    ctx.textAlign = 'center';
    ctx.shadowColor = d.color;
    ctx.shadowBlur = 8;
    ctx.fillText(d.text, d.x, d.y);
    ctx.shadowBlur = 0;
  }
  ctx.globalAlpha = 1;

  // Move cooldown HUD (player side only)
  renderMoveHUD(ctx, W, H);
}

function renderMoveHUD(ctx, W, H) {
  const alive = battleState.playerBalls.filter(b => b.hp > 0);
  if (!alive.length) return;
  const ball = alive[0]; // Show first alive player ball's moves
  const moves = ball.def.moves;
  const now = battleState.time;
  const hudY = H - 22;
  const slotW = 90, gap = 8;
  const totalW = moves.length * slotW + (moves.length - 1) * gap;
  let sx = W / 2 - totalW / 2;

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const cd = ball.moveCooldowns[i];
    const ready = now >= cd;
    const frac = ready ? 1 : 1 - (cd - now) / move.cooldown;
    const col = TYPE_COLORS[move.type] || '#aaa';

    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(sx, hudY - 14, slotW, 14);
    ctx.fillStyle = col + (ready ? 'cc' : '44');
    ctx.fillRect(sx, hudY - 14, slotW * frac, 14);
    ctx.strokeStyle = ready ? col : '#555';
    ctx.lineWidth = 1;
    ctx.strokeRect(sx, hudY - 14, slotW, 14);
    ctx.font = '8px "Courier New", monospace';
    ctx.fillStyle = ready ? '#fff' : '#888';
    ctx.textAlign = 'center';
    ctx.fillText(move.name, sx + slotW / 2, hudY - 4);

    sx += slotW + gap;
  }
}

function lightenColor(hex, amount) {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, (num >> 16) + amount);
  const g = Math.min(255, ((num >> 8) & 0xff) + amount);
  const b = Math.min(255, (num & 0xff) + amount);
  return `rgb(${r},${g},${b})`;
}

// ============================================================
//  STORY MODE
// ============================================================
function initStoryMode() {
  const totalBattles = 5;
  const availableEnemies = [...pokemonData]; // could randomize a bigger pool later
  storyState = {
    battles: totalBattles,
    currentBattle: 0,
    capturedMons: [],
    playerMon: playerTeam[0],
    battleResults: []
  };
  nextStoryBattle();
}

function nextStoryBattle() {
  const s = storyState;
  s.currentBattle++;
  const isBoss = s.currentBattle === s.battles;

  // Pick enemy
  let enemyDef;
  if (isBoss) {
    // Boss: highest total stat mon
    enemyDef = [...pokemonData].sort((a, b) => b.total - a.total)[0];
  } else {
    enemyDef = pokemonData[Math.floor(Math.random() * pokemonData.length)];
  }

  document.getElementById('storyStatus').textContent =
    `Battle ${s.currentBattle}/${s.battles}${isBoss ? ' ⚔️ BOSS' : ''}: vs ${enemyDef.name}`;

  showScreen('battleScreen');
  resizeCanvas();

  const playerBall = createBall(s.playerMon, 0, 0, true);
  const enemyBall = createBall(enemyDef, 0, 0, false);
  enemyBall.isBoss = isBoss;

  startBattle([playerBall], [enemyBall], (result) => {
    storyBattleEnd(result, enemyDef, isBoss, playerBall, enemyBall);
  });
}

function storyBattleEnd(result, enemyDef, isBoss, playerBall, enemyBall) {
  showScreen('storyResultScreen');
  const s = storyState;
  const resultEl = document.getElementById('storyResultText');

  if (result === 'lose') {
    resultEl.innerHTML = `<span class="lose">YOU WERE DEFEATED</span><br><small>Story run ended.</small>`;
    document.getElementById('storyContinueBtn').textContent = 'Back to Menu';
    document.getElementById('storyContinueBtn').onclick = showMenu;
    return;
  }

  // Win — attempt capture
  const hpFrac = enemyBall.hp / enemyBall.maxHp; // should be 0 but just in case
  let captureChance = isBoss ? 0.25 : 0.45;
  if (isBoss) captureChance = 0.3;
  const captured = Math.random() < captureChance;

  let html = `<span class="win">VICTORY!</span><br>`;
  if (captured) {
    storyState.capturedMons.push(enemyDef);
    html += `<span class="capture">🎉 Caught ${enemyDef.name}!</span>`;
    if (!playerTeam.find(p => p.id === enemyDef.id)) playerTeam.push(enemyDef);
  } else {
    html += `<span class="miss">${enemyDef.name} escaped...</span>`;
  }
  resultEl.innerHTML = html;

  if (s.currentBattle >= s.battles) {
    document.getElementById('storyContinueBtn').textContent = 'Run Complete — Back to Menu';
    document.getElementById('storyContinueBtn').onclick = showMenu;
  } else {
    document.getElementById('storyContinueBtn').textContent = `Next Battle →`;
    document.getElementById('storyContinueBtn').onclick = () => {
      showScreen('battleScreen');
      resizeCanvas();
      storyState.playerMon = playerTeam[0]; // could let player pick later
      nextStoryBattle();
    };
  }
}

// ============================================================
//  FREE BATTLE MODE
// ============================================================
function initFreeBattle() {
  showScreen('freeBattleSetup');
  renderTeamSelect();
}

function renderTeamSelect() {
  const container = document.getElementById('teamSelectArea');
  container.innerHTML = '';
  const pool = pokemonData;
  pool.forEach(p => {
    const owned = playerTeam.find(t => t.id === p.id);
    const card = document.createElement('div');
    card.className = 'mon-card' + (owned ? ' owned' : ' locked');
    card.innerHTML = `
      <div class="mon-sprite">${p.sprite}</div>
      <div class="mon-name">${p.name}</div>
      <div class="mon-types">${p.types.map(t => `<span class="type-badge" style="background:${TYPE_COLORS[t]}">${t}</span>`).join('')}</div>
      <div class="mon-stats">HP:${p.hp} ATK:${p.attack} SPD:${p.speed}</div>
      ${!owned ? '<div class="locked-label">LOCKED</div>' : ''}
    `;
    if (owned) card.addEventListener('click', () => startFreeBattle(p));
    container.appendChild(card);
  });
}

function startFreeBattle(playerMon) {
  showScreen('battleScreen');
  resizeCanvas();

  // Random enemy (not the same mon)
  const enemies = pokemonData.filter(p => p.id !== playerMon.id);
  const enemyDef = enemies[Math.floor(Math.random() * enemies.length)];

  const playerBall = createBall(playerMon, 0, 0, true);
  const enemyBall = createBall(enemyDef, 0, 0, false);

  startBattle([playerBall], [enemyBall], (result) => {
    showFreeBattleResult(result, enemyDef);
  });
}

function showFreeBattleResult(result, enemyDef) {
  showScreen('storyResultScreen');
  document.getElementById('storyResultText').innerHTML =
    result === 'win'
      ? `<span class="win">VICTORY!</span><br>Defeated ${enemyDef.name}!`
      : `<span class="lose">DEFEATED</span><br>${enemyDef.name} won...`;
  document.getElementById('storyContinueBtn').textContent = 'Back to Free Battle';
  document.getElementById('storyContinueBtn').onclick = initFreeBattle;
}

// ============================================================
//  SCREEN MANAGEMENT
// ============================================================
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id)?.classList.add('active');
}

function showMenu() {
  showScreen('menuScreen');
  renderRoster();
}

function renderRoster() {
  const el = document.getElementById('rosterDisplay');
  if (!el || !playerTeam.length) return;
  el.innerHTML = 'Your Team: ' + playerTeam.map(p =>
    `<span style="color:${p.color}">${p.sprite}${p.name}</span>`
  ).join(' · ');
}

function resizeCanvas() {
  const canvas = document.getElementById('battleCanvas');
  if (!canvas) return;
  const container = document.getElementById('battleScreen');
  canvas.width = container.clientWidth;
  canvas.height = container.clientHeight - 60;
  ARENA.x = 30; ARENA.y = 30;
  ARENA.w = canvas.width - 60;
  ARENA.h = canvas.height - 100;
}

// ============================================================
//  INIT
// ============================================================
window.addEventListener('load', async () => {
  await loadData();
  // Player starts with first pokemon
  playerTeam = [pokemonData[0]]; // Bulbasaur by default

  // Wire buttons
  document.getElementById('storyBtn').addEventListener('click', () => {
    showScreen('storyPickScreen');
    renderStarterPick();
  });
  document.getElementById('freeBattleBtn').addEventListener('click', initFreeBattle);
  document.getElementById('startStoryBtn').addEventListener('click', () => {
    initStoryMode();
    showScreen('battleScreen');
    resizeCanvas();
  });
  document.getElementById('backToMenuBtn').addEventListener('click', showMenu);
  document.getElementById('backToMenuBtn2').addEventListener('click', showMenu);

  showMenu();
});

function renderStarterPick() {
  const container = document.getElementById('starterPickArea');
  container.innerHTML = '';
  pokemonData.forEach(p => {
    const card = document.createElement('div');
    card.className = 'mon-card starter-option';
    card.innerHTML = `
      <div class="mon-sprite large">${p.sprite}</div>
      <div class="mon-name">${p.name}</div>
      <div class="mon-types">${p.types.map(t => `<span class="type-badge" style="background:${TYPE_COLORS[t]}">${t}</span>`).join('')}</div>
      <table class="stat-table">
        <tr><td>HP</td><td>${p.hp}</td></tr>
        <tr><td>ATK</td><td>${p.attack}</td></tr>
        <tr><td>DEF</td><td>${p.defense}</td></tr>
        <tr><td>SP.ATK</td><td>${p.spAttack}</td></tr>
        <tr><td>SP.DEF</td><td>${p.spDefense}</td></tr>
        <tr><td>SPD</td><td>${p.speed}</td></tr>
      </table>
    `;
    card.addEventListener('click', () => {
      playerTeam = [p];
      document.querySelectorAll('.starter-option').forEach(c => c.classList.remove('selected'));
      card.classList.add('selected');
    });
    container.appendChild(card);
  });
  // Default select first
  container.firstChild?.classList.add('selected');
}

window.addEventListener('resize', () => {
  if (gameState === 'battle') resizeCanvas();
});
