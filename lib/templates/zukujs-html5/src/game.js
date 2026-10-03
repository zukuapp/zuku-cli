// ZukuJS minimal HTML5 jump game: tap, click or press Space/ArrowUp to jump over blocks.
(() => {
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height, GROUND = H - 48;
  const player = { x: 80, y: GROUND - 32, size: 32, vy: 0 };
  let obstacles = [], score = 0, best = 0, speed = 240, spawnIn = 1, over = false, last = performance.now();

  const reset = () => { obstacles = []; score = 0; speed = 240; spawnIn = 1; over = false; player.y = GROUND - player.size; player.vy = 0; };
  const jump = () => {
    if (over) return reset();
    if (player.y >= GROUND - player.size) player.vy = -620;
  };
  addEventListener('keydown', event => { if (event.code === 'Space' || event.code === 'ArrowUp') { event.preventDefault(); jump(); } });
  canvas.addEventListener('pointerdown', event => { event.preventDefault(); jump(); });

  const update = dt => {
    if (over) return;
    player.vy += 1800 * dt;
    player.y = Math.min(player.y + player.vy * dt, GROUND - player.size);
    if ((spawnIn -= dt) <= 0) {
      const h = 24 + Math.random() * 32;
      obstacles.push({ x: W, w: 20 + Math.random() * 18, h });
      spawnIn = 0.9 + Math.random() * 0.9;
    }
    for (const o of obstacles) o.x -= speed * dt;
    obstacles = obstacles.filter(o => o.x + o.w > 0);
    speed += 6 * dt;
    score += dt * 10;
    for (const o of obstacles) {
      if (player.x < o.x + o.w && player.x + player.size > o.x && player.y + player.size > GROUND - o.h) {
        over = true;
        best = Math.max(best, Math.floor(score));
      }
    }
  };

  const draw = () => {
    ctx.fillStyle = '#1b2130'; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#2d3650'; ctx.fillRect(0, GROUND, W, H - GROUND);
    ctx.fillStyle = '#ffcc4d'; ctx.fillRect(player.x, player.y, player.size, player.size);
    ctx.fillStyle = '#ff6b6b';
    for (const o of obstacles) ctx.fillRect(o.x, GROUND - o.h, o.w, o.h);
    ctx.fillStyle = '#f4f6fb'; ctx.font = '20px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(`Score ${Math.floor(score)}  Best ${best}`, 16, 32);
    if (over) { ctx.textAlign = 'center'; ctx.fillText('Game over - tap or press Space', W / 2, H / 2); }
  };

  const frame = now => {
    update(Math.min((now - last) / 1000, 0.05));
    last = now;
    draw();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
})();
