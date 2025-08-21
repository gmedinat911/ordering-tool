
// Simple confetti using canvas (no libs)
(function(){
  const c = document.getElementById('confetti');
  const ctx = c.getContext('2d');
  let W, H, pieces;
  function reset(){
    W = c.width = window.innerWidth;
    H = c.height = window.innerHeight;
    pieces = Array.from({length: Math.min(240, Math.floor(W*H/15000))}, () => spawn());
  }
  function spawn(){
    return {
      x: Math.random()*W,
      y: Math.random()*-H,
      r: 4+Math.random()*6,
      a: Math.random()*Math.PI*2,
      v: 1+Math.random()*3,
      s: 0.01+Math.random()*0.02
    };
  }
  function draw(){
    ctx.clearRect(0,0,W,H);
    for(const p of pieces){
      p.y += p.v;
      p.a += p.s;
      if (p.y > H+20) { p.x = Math.random()*W; p.y = -20; }
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(p.a);
      ctx.fillStyle = ['#7b5cff','#ff6aa8','#ffd166','#00d3ff','#00d39b'][p.y % 5 | 0];
      ctx.fillRect(-p.r/2, -p.r/2, p.r, p.r*1.6);
      ctx.restore();
    }
    requestAnimationFrame(draw);
  }
  window.addEventListener('resize', reset);
  reset(); draw();
})();

// Music toggle (uses a super-short embedded mp3 placeholder; replace with your own file if desired)
(function(){
  const btn = document.getElementById('toggleMusic');
  const audio = document.getElementById('song');
  if (!btn || !audio) return;
  let playing = false;
  btn.addEventListener('click', () => {
    if (!playing){ audio.play().catch(()=>{}); btn.textContent='Pause Music'; }
    else { audio.pause(); btn.textContent='Play Music'; }
    playing = !playing;
  });
})();
