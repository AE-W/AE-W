/* =========================================================================
   Ambient weather background.

   Reads the live weather where I am from Open-Meteo (free, no API key),
   turns it into two attributes on <html> that css/ambient.css styles from,
   and draws the matching particles (rain, snow, drifting fluff, stars).
   ========================================================================= */

(function () {
  'use strict';

  /* ───────────────────────────────────────────────────────────────────────
     WHERE I AM.  Change these two numbers when you move — the sky, the
     colours and the particles all follow.  The badge shows the weather only,
     never the place.  Look up coordinates at https://open-meteo.com
     ─────────────────────────────────────────────────────────────────────── */
  var HOME = { lat: 40.4406, lon: -79.9959 };

  var CACHE_KEY = 'ambient.weather.v1';
  var CACHE_MS = 20 * 60 * 1000;

  var root = document.documentElement;
  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ═══ weather ═══════════════════════════════════════════════════════════ */

  /* WMO weather interpretation codes -> the six scenes we draw */
  function codeToWeather(code) {
    if (code <= 1) return 'clear';                    // clear / mainly clear
    if (code <= 3) return 'cloudy';                   // partly cloudy / overcast
    if (code === 45 || code === 48) return 'fog';
    if (code >= 51 && code <= 67) return 'rain';      // drizzle + rain
    if (code >= 71 && code <= 77) return 'snow';
    if (code >= 80 && code <= 82) return 'rain';      // rain showers
    if (code === 85 || code === 86) return 'snow';    // snow showers
    if (code >= 95) return 'storm';
    return 'cloudy';
  }

  var LABELS = {
    clear:  { day: ['☀️', 'clear'],  night: ['✨', 'clear night'] },
    cloudy: { day: ['⛅', 'cloudy'],       night: ['☁️', 'cloudy night'] },
    rain:   { day: ['\u{1F327}️', 'rain'], night: ['\u{1F327}️', 'rain'] },
    snow:   { day: ['❄️', 'snow'],   night: ['❄️', 'snow'] },
    fog:    { day: ['\u{1F32B}️', 'fog'],  night: ['\u{1F32B}️', 'fog'] },
    storm:  { day: ['⛈️', 'storm'],  night: ['⛈️', 'storm'] }
  };

  /* If the network is down we still want the right half of the day.  Local
     solar time from longitude works no matter what clock the visitor is on. */
  function guessDaylight() {
    var now = new Date();
    var solar = (now.getUTCHours() + now.getUTCMinutes() / 60 + HOME.lon / 15 + 24) % 24;
    return (solar >= 6.5 && solar < 19.5) ? 'day' : 'night';
  }

  function readCache() {
    try {
      var hit = JSON.parse(sessionStorage.getItem(CACHE_KEY));
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.state;
    } catch (e) { /* private mode, or nothing cached */ }
    return null;
  }

  function writeCache(state) {
    try {
      sessionStorage.setItem(CACHE_KEY, JSON.stringify({ at: Date.now(), state: state }));
    } catch (e) { /* not worth caring about */ }
  }

  function fetchWeather() {
    var url = 'https://api.open-meteo.com/v1/forecast' +
      '?latitude=' + HOME.lat + '&longitude=' + HOME.lon +
      '&current=weather_code,is_day,temperature_2m&timezone=auto';

    return fetch(url, { mode: 'cors' })
      .then(function (r) {
        if (!r.ok) throw new Error('weather ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var cur = data.current || {};
        return {
          weather: codeToWeather(cur.weather_code),
          daylight: cur.is_day ? 'day' : 'night',
          temp: typeof cur.temperature_2m === 'number' ? Math.round(cur.temperature_2m) : null,
          live: true
        };
      });
  }

  /* ═══ scene ═════════════════════════════════════════════════════════════ */

  function applyScene(state) {
    root.setAttribute('data-weather', state.weather);
    root.setAttribute('data-daylight', state.daylight);
    sky.retune(state);
    badge.render(state);
  }

  /* ═══ badge ═════════════════════════════════════════════════════════════ */

  var ORDER = ['clear', 'cloudy', 'rain', 'snow', 'fog', 'storm'];

  var badge = (function () {
    var el = document.createElement('button');
    el.type = 'button';
    el.className = 'weather-badge';
    el.setAttribute('aria-live', 'polite');
    el.title = 'Live weather where I am — click to try another sky';

    var live = null;      // the real weather, kept so we can come back to it
    var preview = -1;     // -1 = showing live

    el.addEventListener('click', function () {
      if (!live) return;
      preview += 1;
      if (preview >= ORDER.length) {
        preview = -1;
        applyScene(live);
        return;
      }
      applyScene({
        weather: ORDER[preview],
        daylight: preview % 2 ? 'night' : live.daylight,
        temp: live.temp,
        live: false
      });
    });

    if (document.body) {
      document.body.appendChild(el);
    } else {
      document.addEventListener('DOMContentLoaded', function () {
        document.body.appendChild(el);
      });
    }

    return {
      render: function (state) {
        if (state.live) live = state;
        var pair = (LABELS[state.weather] || LABELS.cloudy)[state.daylight];
        var temp = state.temp === null || state.temp === undefined
          ? '' : '<span class="weather-badge__temp">' + state.temp + '°C</span> · ';
        el.innerHTML =
          '<span class="weather-badge__icon" aria-hidden="true">' + pair[0] + '</span>' +
          '<span>' + temp + pair[1] + '</span>';
        el.classList.add('is-ready');
      }
    };
  })();

  /* ═══ particles ═════════════════════════════════════════════════════════ */

  var sky = (function () {
    var canvas, ctx;
    var W = 0, H = 0, dpr = 1;
    var parts = [];
    var kind = 'motes';
    var tint = '255, 255, 255';
    var flash = 0;
    var raf = null;
    var running = false;

    var KIND_FOR = {
      clear:  { day: 'motes', night: 'stars' },
      cloudy: { day: 'motes', night: 'stars' },
      rain:   { day: 'rain',  night: 'rain' },
      snow:   { day: 'snow',  night: 'snow' },
      fog:    { day: 'fog',   night: 'fog' },
      storm:  { day: 'storm', night: 'storm' }
    };

    function rand(a, b) { return a + Math.random() * (b - a); }

    /* particle count scales with viewport area, capped so phones stay smooth */
    function count(per1000px2, max) {
      return Math.max(8, Math.min(max, Math.round(W * H / 1000 * per1000px2)));
    }

    function seed() {
      parts = [];
      var i, n;

      if (kind === 'motes') {
        n = count(0.030, 90);
        for (i = 0; i < n; i++) {
          parts.push({
            x: rand(0, W), y: rand(0, H), r: rand(1.4, 5.2),
            vy: rand(-0.10, -0.02), amp: rand(6, 26),
            ph: rand(0, Math.PI * 2), sp: rand(0.003, 0.011), a: rand(0.22, 0.6)
          });
        }
      } else if (kind === 'stars') {
        n = count(0.055, 200);
        for (i = 0; i < n; i++) {
          parts.push({
            x: rand(0, W), y: rand(0, H * 0.92), r: rand(0.5, 1.7),
            ph: rand(0, Math.PI * 2), sp: rand(0.008, 0.030), a: rand(0.25, 0.95)
          });
        }
        n = count(0.008, 26);   // a little fluff drifting among the stars
        for (i = 0; i < n; i++) {
          parts.push({
            mote: true, x: rand(0, W), y: rand(0, H), r: rand(1.6, 4.4),
            vy: rand(-0.08, -0.02), amp: rand(8, 24),
            ph: rand(0, Math.PI * 2), sp: rand(0.003, 0.009), a: rand(0.14, 0.36)
          });
        }
      } else if (kind === 'rain' || kind === 'storm') {
        n = count(kind === 'storm' ? 0.16 : 0.11, kind === 'storm' ? 420 : 300);
        for (i = 0; i < n; i++) {
          parts.push({
            x: rand(0, W + 140), y: rand(-H, H), len: rand(11, 30),
            vy: rand(6.5, 14), w: rand(0.8, 1.8), a: rand(0.22, 0.60)
          });
        }
      } else if (kind === 'snow') {
        n = count(0.055, 220);
        for (i = 0; i < n; i++) {
          parts.push({
            x: rand(0, W), y: rand(-H, H), r: rand(1.3, 4.6),
            vy: rand(0.22, 0.95), amp: rand(10, 40),
            ph: rand(0, Math.PI * 2), sp: rand(0.004, 0.014), a: rand(0.42, 0.95)
          });
        }
      } else if (kind === 'fog') {
        n = 14;
        for (i = 0; i < n; i++) {
          parts.push({
            x: rand(-0.2 * W, 1.2 * W), y: rand(0, H),
            rx: rand(W * 0.18, W * 0.55), ry: rand(40, 150),
            vx: rand(0.08, 0.42) * (Math.random() < 0.5 ? -1 : 1),
            a: rand(0.07, 0.22)
          });
        }
      }
    }

    function softDot(x, y, r, alpha) {
      var g = ctx.createRadialGradient(x, y, 0, x, y, r);
      g.addColorStop(0, 'rgba(' + tint + ',' + alpha + ')');
      g.addColorStop(0.45, 'rgba(' + tint + ',' + alpha * 0.55 + ')');
      g.addColorStop(1, 'rgba(' + tint + ',0)');
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }

    function frame(t) {
      ctx.clearRect(0, 0, W, H);
      var i, p;

      if (kind === 'motes' || kind === 'stars') {
        for (i = 0; i < parts.length; i++) {
          p = parts[i];
          if (p.vy !== undefined) {                   // drifting fluff
            p.y += p.vy;
            p.ph += p.sp;
            if (p.y < -12) { p.y = H + 12; p.x = rand(0, W); }
            softDot(p.x + Math.sin(p.ph) * p.amp, p.y, p.r * 2.6, p.a);
          } else {                                    // twinkling star
            p.ph += p.sp;
            var tw = p.a * (0.55 + 0.45 * Math.sin(p.ph));
            softDot(p.x, p.y, p.r * 3.2, tw);
          }
        }
      } else if (kind === 'snow') {
        for (i = 0; i < parts.length; i++) {
          p = parts[i];
          p.y += p.vy;
          p.ph += p.sp;
          if (p.y > H + 10) { p.y = -10; p.x = rand(0, W); }
          softDot(p.x + Math.sin(p.ph) * p.amp, p.y, p.r * 2.2, p.a);
        }
      } else if (kind === 'rain' || kind === 'storm') {
        ctx.lineCap = 'round';
        for (i = 0; i < parts.length; i++) {
          p = parts[i];
          p.y += p.vy;
          p.x -= p.vy * 0.16;                          // wind-blown slant
          if (p.y > H + 20) { p.y = rand(-60, -10); p.x = rand(0, W + 140); }
          ctx.strokeStyle = 'rgba(' + tint + ',' + p.a + ')';
          ctx.lineWidth = p.w;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x + p.len * 0.16, p.y - p.len);
          ctx.stroke();
        }
        if (kind === 'storm') {
          if (flash > 0) {
            ctx.fillStyle = 'rgba(255,255,255,' + (flash * 0.32) + ')';
            ctx.fillRect(0, 0, W, H);
            flash -= 0.055;
          } else if (Math.random() < 0.0022) {
            flash = 1;
          }
        }
      } else if (kind === 'fog') {
        for (i = 0; i < parts.length; i++) {
          p = parts[i];
          p.x += p.vx;
          if (p.x - p.rx > W) p.x = -p.rx;
          if (p.x + p.rx < 0) p.x = W + p.rx;
          var g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, p.rx);
          g.addColorStop(0, 'rgba(' + tint + ',' + p.a + ')');
          g.addColorStop(1, 'rgba(' + tint + ',0)');
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.scale(1, p.ry / p.rx);
          ctx.translate(-p.x, -p.y);
          ctx.fillStyle = g;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.rx, 0, Math.PI * 2);
          ctx.fill();
          ctx.restore();
        }
      }

      raf = window.requestAnimationFrame(frame);
    }

    function start() {
      if (running || reduceMotion || !ctx) return;
      running = true;
      raf = window.requestAnimationFrame(frame);
    }

    function stop() {
      running = false;
      if (raf) window.cancelAnimationFrame(raf);
      raf = null;
    }

    function resize() {
      if (!canvas) return;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.clientWidth;
      H = canvas.clientHeight;
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      seed();
    }

    return {
      mount: function () {
        canvas = document.querySelector('.ambient__canvas');
        if (!canvas || !canvas.getContext) return;
        ctx = canvas.getContext('2d');
        resize();

        var t = null;
        window.addEventListener('resize', function () {
          window.clearTimeout(t);
          t = window.setTimeout(resize, 180);
        });

        document.addEventListener('visibilitychange', function () {
          if (document.hidden) stop(); else start();
        });

        start();
      },

      retune: function (state) {
        kind = (KIND_FOR[state.weather] || KIND_FOR.cloudy)[state.daylight];
        flash = 0;
        // colours live in CSS; read whatever the scene just set
        var v = window.getComputedStyle(root).getPropertyValue('--particle').trim();
        if (v) tint = v;
        if (ctx) { seed(); start(); }
      }
    };
  })();

  /* ═══ boot ══════════════════════════════════════════════════════════════ */

  /* ?sky=rain / ?sky=snow-night / ... pins a scene, for previewing one
     without waiting for the weather to oblige */
  function pinnedScene() {
    var m = /[?&]sky=([a-z]+)(?:-(day|night))?/.exec(window.location.search);
    if (!m || ORDER.indexOf(m[1]) === -1) return null;
    return {
      weather: m[1],
      daylight: m[2] || guessDaylight(),
      temp: null,
      live: false
    };
  }

  function boot() {
    sky.mount();

    var pinned = pinnedScene();
    if (pinned) {
      applyScene(pinned);
      return;
    }

    var cached = readCache();
    if (cached) {
      applyScene(cached);
    } else {
      // paint something sensible immediately, correct it when the API answers
      applyScene({ weather: 'clear', daylight: guessDaylight(), temp: null, live: true });
    }

    fetchWeather().then(function (state) {
      writeCache(state);
      applyScene(state);
    }).catch(function () {
      /* offline or rate-limited: the time-of-day guess above stands */
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
