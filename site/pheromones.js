// Pheromone field: ambient background that evokes the idea —
// agents walk, deposit trails, trails decay. Lightweight, no deps.

(function () {
  const prefersReduced =
    window.matchMedia &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (prefersReduced) return;

  const canvas = document.getElementById("pheromone-field");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");

  let w = 0;
  let h = 0;
  let dpr = Math.min(window.devicePixelRatio || 1, 2);

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = window.innerWidth;
    h = window.innerHeight;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  // Agents wander, leaving faint trails. The trails are the "pheromones".
  const AGENT_COUNT = Math.max(6, Math.min(14, Math.floor((w * h) / 160000)));
  const agents = Array.from({ length: AGENT_COUNT }, () => spawn());

  function spawn() {
    return {
      x: Math.random() * w,
      y: Math.random() * h,
      a: Math.random() * Math.PI * 2,
      v: 0.35 + Math.random() * 0.45,
      hue: 78 + Math.random() * 14, // greenish-yellow range
      life: 300 + Math.random() * 400,
    };
  }

  // Paint a very faint black rectangle each frame to cause exponential
  // trail decay — this is decay, the primitive, rendered as a visual.
  function tick() {
    // decay
    ctx.fillStyle = "rgba(11, 13, 10, 0.035)";
    ctx.fillRect(0, 0, w, h);

    for (let i = 0; i < agents.length; i++) {
      const ag = agents[i];
      // Wander: small random turn
      ag.a += (Math.random() - 0.5) * 0.25;
      ag.x += Math.cos(ag.a) * ag.v;
      ag.y += Math.sin(ag.a) * ag.v;
      ag.life -= 1;

      // Wrap around edges
      if (ag.x < -20) ag.x = w + 20;
      if (ag.x > w + 20) ag.x = -20;
      if (ag.y < -20) ag.y = h + 20;
      if (ag.y > h + 20) ag.y = -20;

      // Deposit — trail dot
      const alpha = 0.38 + Math.sin(ag.life / 40) * 0.08;
      ctx.fillStyle = `hsla(${ag.hue}, 85%, 60%, ${alpha})`;
      ctx.beginPath();
      ctx.arc(ag.x, ag.y, 0.9, 0, Math.PI * 2);
      ctx.fill();

      if (ag.life <= 0) agents[i] = spawn();
    }

    requestAnimationFrame(tick);
  }

  tick();
})();
