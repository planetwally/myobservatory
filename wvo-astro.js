/*
 * Washington Valley Observatory  ·  myobservatory.org
 * Copyright (c) 2025-2026 Washington Valley Observatory. All rights reserved.
 * Not licensed for reuse or redistribution. See LICENSE.
 *
 * Shared sky math and point forecast for the Observatory Tools on myobservatory.org.
 *
 *   WVO.astro   sun / moon ephemeris, sidereal time, apparent places of
 *               catalogue stars, the seeing / transparency heuristics, and a
 *               cached Open-Meteo point forecast
 *
 * The sun/moon block and the scores began inside sky.html, and this file is
 * shared with the Observatory Tools app. Keep the heuristics in step with
 * sky.html's copy -- two copies drift apart the first time one gets tuned.
 *
 * Two levels of precision, on purpose:
 *   - sunAlt / moonAlt / moonIllum are the compact suncalc-style series: good
 *     to a fraction of a degree, which is all a darkness band or a moonrise
 *     time needs.
 *   - apparent() / lst() are the Meeus low-precision reductions (precession,
 *     nutation, annual aberration, apparent sidereal time). Polaris sits 0.6°
 *     from the pole, where a 20″ nutation term swings its right ascension by
 *     almost two minutes of time -- enough to disagree visibly with a mount's
 *     hand controller if it were left out.
 *
 * Loaded after wvo-store.js (it needs WVO.read / WVO.write for the forecast
 * cache) and before the page's own script.
 */
(function (global) {
  'use strict';

  var WVO = global.WVO || (global.WVO = {});
  var PI = Math.PI;
  var rad = function (d) { return d * PI / 180; };
  var deg = function (r) { return r * 180 / PI; };
  var clamp = function (v, a, b) { return Math.min(b, Math.max(a, v)); };
  var norm360 = function (a) { return ((a % 360) + 360) % 360; };
  var ASEC = PI / 180 / 3600;

  /* ================= SUN & MOON (compact ephemeris, suncalc-style) ================= */

  var OBLIQ = rad(23.4397);
  function toDays(date) { return date.getTime() / 86400000 - 10957.5; }   /* days since J2000.0 */
  function eclToEq(lon, lat) {
    return {
      ra: Math.atan2(Math.sin(lon) * Math.cos(OBLIQ) - Math.tan(lat) * Math.sin(OBLIQ), Math.cos(lon)),
      dec: Math.asin(Math.sin(lat) * Math.cos(OBLIQ) + Math.cos(lat) * Math.sin(OBLIQ) * Math.sin(lon))
    };
  }
  function sunCoords(d) {
    var M = rad(357.5291 + 0.98560028 * d);
    var C = rad(1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
    var L = M + C + rad(282.9372);                    /* ecliptic longitude */
    var eq = eclToEq(L, 0);
    eq.dist = 149598000;
    return eq;
  }
  function moonCoords(d) {
    var L = rad(218.316 + 13.176396 * d);             /* mean longitude */
    var M = rad(134.963 + 13.064993 * d);             /* mean anomaly */
    var F = rad(93.272 + 13.229350 * d);              /* mean distance */
    var lon = L + rad(6.289 * Math.sin(M));
    var lat = rad(5.128 * Math.sin(F));
    var eq = eclToEq(lon, lat);
    eq.dist = 385001 - 20905 * Math.cos(M);
    return eq;
  }
  function siderealRad(d, lonDeg) { return rad(280.16 + 360.9856235 * d) + rad(lonDeg); }
  function bodyAlt(eq, date, latDeg, lonDeg) {
    var d = toDays(date);
    var H = siderealRad(d, lonDeg) - eq.ra;
    var la = rad(latDeg);
    return deg(Math.asin(Math.sin(la) * Math.sin(eq.dec) + Math.cos(la) * Math.cos(eq.dec) * Math.cos(H)));
  }
  function sunAlt(date, la, lo) { return bodyAlt(sunCoords(toDays(date)), date, la, lo); }
  function moonAlt(date, la, lo) { return bodyAlt(moonCoords(toDays(date)), date, la, lo); }
  function moonIllum(date) {
    var d = toDays(date), s = sunCoords(d), m = moonCoords(d);
    var phi = Math.acos(clamp(Math.sin(s.dec) * Math.sin(m.dec)
            + Math.cos(s.dec) * Math.cos(m.dec) * Math.cos(s.ra - m.ra), -1, 1));
    var inc = Math.atan2(s.dist * Math.sin(phi), m.dist - s.dist * Math.cos(phi));
    var waxing = Math.sin(s.ra - m.ra) < 0 ? 1 : -1;  /* rough waxing/waning flag */
    return { frac: (1 + Math.cos(inc)) / 2, waxing: waxing > 0 };
  }
  /* moon position of date, degrees -- for target separation */
  function moonRaDec(date) {
    var m = moonCoords(toDays(date));
    return { ra: norm360(deg(m.ra)), dec: deg(m.dec) };
  }
  /* find times when fn(date) crosses `level`; scans [t0,t1] in `stepMin` steps */
  function findCrossings(fn, t0, t1, level, stepMin) {
    var out = [];
    var prev = fn(new Date(t0));
    for (var t = t0 + stepMin * 60000; t <= t1; t += stepMin * 60000) {
      var cur = fn(new Date(t));
      if ((prev < level) !== (cur < level)) {
        /* refine by bisection to ~30 s */
        var a = t - stepMin * 60000, b = t;
        for (var i = 0; i < 8; i++) {
          var mid = (a + b) / 2;
          if ((fn(new Date(mid)) < level) === (prev < level)) a = mid; else b = mid;
        }
        out.push({ t: new Date((a + b) / 2), rising: cur > prev });
      }
      prev = cur;
    }
    return out;
  }

  /* ================= SCORES (documented heuristics) ================= */

  function seeingScore(h) {                   /* 1–5, wind-shear proxy (km/h inputs) */
    var s = 5;
    if (h.w200 != null) { if (h.w200 >= 180) s -= 2.5; else if (h.w200 >= 130) s -= 1.5; else if (h.w200 >= 90) s -= 0.5; }
    if (h.w500 != null) { if (h.w500 >= 70) s -= 1; else if (h.w500 >= 45) s -= 0.5; }
    if (h.gust != null) { if (h.gust >= 45) s -= 1; else if (h.gust >= 30) s -= 0.5; }
    return clamp(Math.round(s), 1, 5);
  }
  function transScore(h) {                    /* 1–5, aerosol + moisture proxy */
    var s = 5;
    if (h.aod != null) { if (h.aod >= 0.5) s -= 2.5; else if (h.aod >= 0.25) s -= 1.5; else if (h.aod >= 0.12) s -= 0.5; }
    if (h.rh != null) { if (h.rh >= 95) s -= 2; else if (h.rh >= 85) s -= 1; }
    if (h.temp != null && h.dew != null) { var sp = h.temp - h.dew; if (sp <= 1.5) s -= 1; else if (sp <= 3) s -= 0.5; }
    return clamp(Math.round(s), 1, 5);
  }
  function hourClass(h) {                     /* good / fair / poor chip */
    if (h.pprob != null && h.pprob >= 40) return 'poor';
    if (h.cloud <= 25 && seeingScore(h) >= 3 && transScore(h) >= 3) return 'good';
    if (h.cloud <= 60) return 'fair';
    return 'poor';
  }

  /* ================= APPARENT PLACES + SIDEREAL TIME (Meeus) ================= */

  function julian(date) { return date.getTime() / 86400000 + 2440587.5; }

  /* nutation in longitude / obliquity, the four largest terms (Meeus ch. 22):
     good to ~0.5″, far below anything a polar scope can show */
  function nutation(T) {
    var om = rad(125.04452 - 1934.136261 * T);
    var Ls = rad(280.4665 + 36000.7698 * T);
    var Lm = rad(218.3165 + 481267.8813 * T);
    var dpsi = -17.20 * Math.sin(om) - 1.32 * Math.sin(2 * Ls) - 0.23 * Math.sin(2 * Lm) + 0.21 * Math.sin(2 * om);
    var deps = 9.20 * Math.cos(om) + 0.57 * Math.cos(2 * Ls) + 0.10 * Math.cos(2 * Lm) - 0.09 * Math.cos(2 * om);
    var eps0 = 23.439291111 - (46.8150 * T + 0.00059 * T * T - 0.001813 * T * T * T) / 3600;
    return { dpsi: dpsi * ASEC, deps: deps * ASEC, eps0: rad(eps0), eps: rad(eps0) + deps * ASEC };
  }

  /* Local apparent sidereal time, degrees. lonDeg is east-positive. */
  function lst(date, lonDeg) {
    var jd = julian(date), T = (jd - 2451545) / 36525;
    var gmst = 280.46061837 + 360.98564736629 * (jd - 2451545) + 0.000387933 * T * T - T * T * T / 38710000;
    var n = nutation(T);
    return norm360(gmst + deg(n.dpsi * Math.cos(n.eps)) + lonDeg);
  }

  function toEcl(a, d, eps) {
    return {
      l: Math.atan2(Math.sin(a) * Math.cos(eps) + Math.tan(d) * Math.sin(eps), Math.cos(a)),
      b: Math.asin(Math.sin(d) * Math.cos(eps) - Math.cos(d) * Math.sin(eps) * Math.sin(a))
    };
  }
  function fromEcl(l, b, eps) {
    return {
      a: Math.atan2(Math.sin(l) * Math.cos(eps) - Math.tan(b) * Math.sin(eps), Math.cos(l)),
      d: Math.asin(Math.sin(b) * Math.cos(eps) + Math.cos(b) * Math.sin(eps) * Math.sin(l))
    };
  }

  /*
   * J2000 catalogue place -> apparent place of date, degrees.
   * pmRA is µα·cosδ and pmDec µδ, both mas/yr (Hipparcos convention); omit
   * them for anything that isn't a bright nearby star.
   *
   * Nutation and aberration are applied as rotations in ecliptic coordinates
   * rather than through the usual first-order Δα/Δδ formulas, because those
   * carry a tanδ that blows up at the declination of a pole star.
   */
  function apparent(raDeg, decDeg, date, pmRA, pmDec) {
    var jd = julian(date), T = (jd - 2451545) / 36525, yrs = T * 100;
    var d0 = rad(decDeg);
    var a0 = rad(raDeg) + (pmRA ? pmRA / 1000 * ASEC * yrs / Math.cos(d0) : 0);
    d0 += pmDec ? pmDec / 1000 * ASEC * yrs : 0;

    /* precession, IAU 1976 (Meeus 21.2–21.4) */
    var zeta = (2306.2181 * T + 0.30188 * T * T + 0.017998 * T * T * T) * ASEC;
    var z = (2306.2181 * T + 1.09468 * T * T + 0.018203 * T * T * T) * ASEC;
    var th = (2004.3109 * T - 0.42665 * T * T - 0.041833 * T * T * T) * ASEC;
    var A = Math.cos(d0) * Math.sin(a0 + zeta);
    var B = Math.cos(th) * Math.cos(d0) * Math.cos(a0 + zeta) - Math.sin(th) * Math.sin(d0);
    var C = Math.sin(th) * Math.cos(d0) * Math.cos(a0 + zeta) + Math.cos(th) * Math.sin(d0);
    var a = Math.atan2(A, B) + z, d = Math.asin(clamp(C, -1, 1));

    /* to the mean ecliptic of date, then annual aberration (Meeus 23.2) */
    var n = nutation(T);
    var e = toEcl(a, d, n.eps0);
    var M = rad(357.52911 + 35999.05029 * T);
    var sunL = rad(280.46646 + 36000.76983 * T
      + (1.914602 - 0.004817 * T) * Math.sin(M) + 0.019993 * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M));
    var ecc = 0.016708634 - 0.000042037 * T;
    var peri = rad(102.93735 + 1.71946 * T);
    var k = 20.49552 * ASEC;
    var l = e.l + (-k * Math.cos(sunL - e.l) + ecc * k * Math.cos(peri - e.l)) / Math.cos(e.b);
    var b = e.b - k * Math.sin(e.b) * (Math.sin(sunL - e.l) - ecc * Math.sin(peri - e.l));

    /* nutation: shift the longitude, return on the true equator */
    var q = fromEcl(l + n.dpsi, b, n.eps);
    return { ra: norm360(deg(q.a)), dec: deg(q.d) };
  }

  /* hour angle (degrees, -180..180, west positive) and alt/az of an apparent place */
  function horizontal(raDeg, decDeg, date, latDeg, lonDeg) {
    var ha = norm360(lst(date, lonDeg) - raDeg);
    if (ha > 180) ha -= 360;
    var H = rad(ha), d = rad(decDeg), la = rad(latDeg);
    var alt = Math.asin(Math.sin(la) * Math.sin(d) + Math.cos(la) * Math.cos(d) * Math.cos(H));
    var az = Math.atan2(-Math.sin(H) * Math.cos(d), Math.sin(d) * Math.cos(la) - Math.cos(d) * Math.sin(la) * Math.cos(H));
    return { ha: ha, alt: deg(alt), az: norm360(deg(az)) };
  }

  /* angular distance between two RA/Dec positions, degrees */
  function separation(ra1, dec1, ra2, dec2) {
    var a = rad(dec1), b = rad(dec2);
    return deg(Math.acos(clamp(Math.sin(a) * Math.sin(b) + Math.cos(a) * Math.cos(b) * Math.cos(rad(ra1 - ra2)), -1, 1)));
  }

  /* ================= POINT FORECAST (Open-Meteo, cached) ================= */

  /*
   * The field is exactly where there's no signal, so the last few forecasts
   * are kept in storage by site. A failed fetch falls back to the nearest
   * cached copy and says how old it is, rather than showing nothing.
   */
  var OM_FORECAST = 'https://api.open-meteo.com/v1/forecast';
  var OM_AIR = 'https://air-quality-api.open-meteo.com/v1/air-quality';
  var FC_KEY = 'wvo:forecast';
  var FC_KEEP = 4;
  var FC_NEAR = 0.05;                   /* degrees: same site for cache purposes */

  function cachedForecast(lat, lon) {
    var list = WVO.read ? WVO.read(FC_KEY, []) : [];
    if (!Array.isArray(list)) return null;
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c && Math.abs(c.lat - lat) < FC_NEAR && Math.abs(c.lon - lon) < FC_NEAR && Array.isArray(c.hours)) return c;
    }
    return null;
  }
  function storeForecast(fc) {
    if (!WVO.write) return;
    var list = WVO.read(FC_KEY, []);
    if (!Array.isArray(list)) list = [];
    list = list.filter(function (c) {
      return c && !(Math.abs(c.lat - fc.lat) < FC_NEAR && Math.abs(c.lon - fc.lon) < FC_NEAR);
    });
    list.unshift(fc);
    WVO.write(FC_KEY, list.slice(0, FC_KEEP));
  }

  function fetchForecast(lat, lon, days) {
    days = days || 7;
    var common = 'latitude=' + lat.toFixed(4) + '&longitude=' + lon.toFixed(4) +
      '&timeformat=unixtime&timezone=auto&past_days=1&forecast_days=' + days;
    var wxURL = OM_FORECAST + '?' + common + '&hourly=temperature_2m,relative_humidity_2m,dew_point_2m,' +
      'cloud_cover,cloud_cover_low,cloud_cover_mid,cloud_cover_high,precipitation_probability,' +
      'wind_speed_10m,wind_gusts_10m,wind_speed_850hPa,wind_speed_500hPa,wind_speed_200hPa';
    var aqURL = OM_AIR + '?' + common + '&hourly=aerosol_optical_depth';

    return Promise.allSettled([fetch(wxURL), fetch(aqURL)]).then(function (r) {
      if (r[0].status !== 'fulfilled' || !r[0].value.ok) throw new Error('forecast fetch failed');
      var aqP = (r[1].status === 'fulfilled' && r[1].value.ok) ? r[1].value.json().catch(function () { return null; }) : null;
      return Promise.all([r[0].value.json(), aqP]);
    }).then(function (res) {
      var wx = res[0], aq = res[1];
      var aod = new Map();
      if (aq && aq.hourly) (aq.hourly.time || []).forEach(function (tt, i) { aod.set(tt, aq.hourly.aerosol_optical_depth[i]); });
      var h = wx.hourly;
      var pick = function (k, i) { return h[k] ? h[k][i] : null; };
      var fc = {
        lat: lat, lon: lon, fetchedAt: Date.now(),
        tz: wx.timezone || null, offset: wx.utc_offset_seconds || 0,
        hours: h.time.map(function (tt, i) {
          return {
            tt: tt, cloud: h.cloud_cover[i], lo: h.cloud_cover_low[i], mi: h.cloud_cover_mid[i], hi: h.cloud_cover_high[i],
            temp: h.temperature_2m[i], rh: h.relative_humidity_2m[i], dew: h.dew_point_2m[i],
            pprob: pick('precipitation_probability', i),
            wind: h.wind_speed_10m[i], gust: h.wind_gusts_10m[i],
            w850: pick('wind_speed_850hPa', i), w500: pick('wind_speed_500hPa', i), w200: pick('wind_speed_200hPa', i),
            aod: aod.has(tt) ? aod.get(tt) : null
          };
        })
      };
      storeForecast(fc);
      fc.stale = false;
      return fc;
    }).catch(function (err) {
      var c = cachedForecast(lat, lon);
      if (!c) throw err;
      c.stale = true;
      return c;
    });
  }

  WVO.astro = {
    rad: rad, deg: deg, clamp: clamp, norm360: norm360,
    toDays: toDays, sunCoords: sunCoords, moonCoords: moonCoords,
    sunAlt: sunAlt, moonAlt: moonAlt, moonIllum: moonIllum, moonRaDec: moonRaDec,
    findCrossings: findCrossings,
    seeingScore: seeingScore, transScore: transScore, hourClass: hourClass,
    julian: julian, lst: lst, apparent: apparent, horizontal: horizontal, separation: separation,
    fetchForecast: fetchForecast, cachedForecast: cachedForecast
  };
})(window);
