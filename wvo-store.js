/*
 * Shared state for the Observatory Tools on myobservatory.org.
 *
 * The five tools grew up as independent pages, so each one carries its own
 * equipment tables, its own observer lat/lon box, and its own night-vision
 * toggle. That means entering your site three times and losing red-light mode
 * on every navigation. This module is the one place that state lives:
 *
 *   WVO.site   observer location, shared by Atlas / FOV / Sky Planner
 *   WVO.night  red-light mode, persisted across pages
 *   WVO.gear   the user's own scopes, cameras, reducers and rig combos
 *   WVO.prefs  per-tool "remember what I had last time" helper
 *
 * Loaded synchronously in <head> on every page so the night-vision class is on
 * <html> before first paint -- deferring it makes the page flash white-blue at
 * a dark site, which is exactly what red-light mode exists to prevent.
 *
 * Everything degrades to defaults if localStorage is unavailable or corrupt
 * (private windows, cleared site data, a WebView with storage disabled).
 */
(function (global) {
  'use strict';

  var NS = 'wvo:';
  var KEY_SITE = NS + 'site';
  var KEY_NIGHT = NS + 'night';
  var KEY_GEAR = NS + 'gear';
  var PREF_PREFIX = NS + 'pref:';

  /* ---------------- storage primitives ---------------- */

  function read(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      return false; /* quota, private mode, storage disabled */
    }
  }

  function remove(key) {
    try { localStorage.removeItem(key); } catch (e) {}
  }

  function uid() {
    return 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ---------------- observer site ---------------- */

  var DEFAULT_SITE = { lat: 40.797, lon: -74.482, name: 'Observatory' };

  var site = {
    get: function () {
      var s = read(KEY_SITE, null);
      if (!s || !isFinite(+s.lat) || !isFinite(+s.lon)) return Object.assign({}, DEFAULT_SITE);
      return { lat: +s.lat, lon: +s.lon, name: s.name || '' };
    },
    set: function (lat, lon, name) {
      lat = +lat; lon = +lon;
      if (!isFinite(lat) || !isFinite(lon)) return false;
      if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return false;
      var cur = site.get();
      write(KEY_SITE, { lat: lat, lon: lon, name: name != null ? name : cur.name });
      return true;
    },
    isDefault: function () { return read(KEY_SITE, null) === null; }
  };

  /* ---------------- night vision ---------------- */

  var night = {
    isOn: function () { return read(KEY_NIGHT, false) === true; },
    set: function (on) {
      write(KEY_NIGHT, !!on);
      night.apply();
    },
    toggle: function () { night.set(!night.isOn()); return night.isOn(); },
    apply: function () {
      var el = document.documentElement;
      if (night.isOn()) el.classList.add('night');
      else el.classList.remove('night');
    }
  };

  /* ---------------- gear library ---------------- */

  /*
   * Components are stored separately from rigs so one camera can appear in
   * several combos without duplicating its specs -- edit the camera once and
   * every rig using it updates. Sensor dimensions in mm are always derived
   * from pixel size x pixel count rather than stored, so they can never drift
   * out of agreement with the pixel scale.
   */
  /*
   * Rig categories. One flat list, mixing framing class with a portability tag,
   * because that's how the rigs actually get picked in the field ("what's my
   * wide option tonight?" / "what am I taking in the car?").
   */
  var CATEGORIES = [
    { id: 'ultrawide', name: 'Ultra wide' },
    { id: 'wide',      name: 'Wide' },
    { id: 'mid',       name: 'Mid' },
    { id: 'narrow',    name: 'Narrow' },
    { id: 'long',      name: 'Long / planetary' },
    { id: 'mobile',    name: 'Mobile / travel' },
    { id: 'other',     name: 'Uncategorised' }
  ];

  /* A starting point only -- effective focal length is the usual shorthand
     imagers use for framing class, and the picker lets you override it. */
  function suggestCategory(fl) {
    if (!(fl > 0)) return 'other';
    if (fl < 200) return 'ultrawide';
    if (fl < 300) return 'wide';
    if (fl < 450) return 'mid';
    if (fl < 800) return 'narrow';
    return 'long';
  }

  function categoryName(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === id) return CATEGORIES[i].name;
    return 'Uncategorised';
  }

  /* The observatory's own fleet, so the library is useful before anyone edits
     it. Focal lengths here are NATIVE -- the reducer is a separate component,
     so the rig's working focal length is always derived rather than stored and
     cannot drift away from the glass it belongs to. Mirrors the nine active
     rigs listed on the site's home page; the retired ones are left out. */
  function seedGear() {
    var s = {
      sharp76: { id: 'sharp76', name: 'Sharpstar 76EDPH', ap: 76, fl: 418 },
      sharp61: { id: 'sharp61', name: 'Sharpstar 61EDPH II', ap: 61, fl: 335 },
      fra300:  { id: 'fra300',  name: 'Askar FRA300 Pro', ap: 60, fl: 300 },
      askar65: { id: 'askar65', name: 'Askar 65PHQ', ap: 65, fl: 416 },
      at60edp: { id: 'at60edp', name: 'Astro-Tech AT60EDP', ap: 60, fl: 300 },
      wcat51:  { id: 'wcat51',  name: 'William Optics WhiteCat 51', ap: 51, fl: 250 },
      fma180:  { id: 'fma180',  name: 'Askar FMA180 Pro', ap: 40, fl: 220 },
      fma135:  { id: 'fma135',  name: 'Askar FMA135', ap: 30, fl: 135 },
      fs60cb:  { id: 'fs60cb',  name: 'Takahashi FS-60CB', ap: 60, fl: 366 }
    };
    /* every 585 variant is the same IMX585 sensor -- they are listed separately
       because the rigs below say which physical body is on which scope */
    var c = {
      a585air: { id: 'a585air', name: 'ZWO ASI585MC Air', px: 2.9, pw: 3840, ph: 2160 },
      a585pro: { id: 'a585pro', name: 'ZWO ASI585MC Pro', px: 2.9, pw: 3840, ph: 2160 },
      a585:    { id: 'a585',    name: 'ZWO ASI585MC', px: 2.9, pw: 3840, ph: 2160 },
      asi2600: { id: 'asi2600', name: 'ZWO ASI2600MC Pro', px: 3.76, pw: 6248, ph: 4176 }
    };
    var r = {
      none: { id: 'none', name: 'None (native)', v: 1 },
      r082: { id: 'r082', name: '0.82× reducer', v: 0.82 },
      r084: { id: 'r084', name: '0.84× reducer', v: 0.84 }
    };
    return {
      v: 1,
      scopes: [s.sharp76, s.sharp61, s.fra300, s.askar65, s.at60edp, s.wcat51, s.fma180, s.fma135, s.fs60cb],
      cameras: [c.a585air, c.a585pro, c.a585, c.asi2600],
      reducers: [r.none, r.r082, r.r084],
      rigs: [
        { id: 'rig1', name: 'Sharpstar 76EDPH · 585 Air', scopeId: 'sharp76', cameraId: 'a585air', reducerId: 'r082', category: 'mid' },
        { id: 'rig2', name: 'Sharpstar 61EDPH II · 585 Air', scopeId: 'sharp61', cameraId: 'a585air', reducerId: 'r082', category: 'wide' },
        { id: 'rig3', name: 'Askar FRA300 Pro · 585 Air', scopeId: 'fra300', cameraId: 'a585air', reducerId: 'none', category: 'mid' },
        { id: 'rig4', name: 'Askar 65PHQ · 585 Air', scopeId: 'askar65', cameraId: 'a585air', reducerId: 'none', category: 'mid' },
        { id: 'rig5', name: 'AT60EDP · 2600', scopeId: 'at60edp', cameraId: 'asi2600', reducerId: 'none', category: 'mid' },
        { id: 'rig6', name: 'WhiteCat 51 · 585 Air', scopeId: 'wcat51', cameraId: 'a585air', reducerId: 'none', category: 'wide' },
        { id: 'rig7', name: 'FMA180 · 585 Pro', scopeId: 'fma180', cameraId: 'a585pro', reducerId: 'r082', category: 'ultrawide' },
        { id: 'rig8', name: 'FMA135 · 585', scopeId: 'fma135', cameraId: 'a585', reducerId: 'none', category: 'ultrawide' },
        { id: 'rig9', name: 'FS-60CB · 585 Pro', scopeId: 'fs60cb', cameraId: 'a585pro', reducerId: 'none', category: 'mobile' }
      ],
      activeRigId: 'rig1'
    };
  }

  function normaliseGear(g) {
    if (!g || typeof g !== 'object') return seedGear();
    var out = {
      v: 1,
      scopes: Array.isArray(g.scopes) ? g.scopes : [],
      cameras: Array.isArray(g.cameras) ? g.cameras : [],
      reducers: Array.isArray(g.reducers) ? g.reducers : [],
      rigs: Array.isArray(g.rigs) ? g.rigs : [],
      activeRigId: g.activeRigId || null
    };
    /* a library with no reducer at all can't express "native" -- always offer one */
    if (!out.reducers.length) out.reducers = [{ id: 'none', name: 'None (native)', v: 1 }];
    return out;
  }

  var gearCache = null;

  var gear = {
    all: function () {
      if (gearCache) return gearCache;
      var raw = read(KEY_GEAR, null);
      gearCache = raw === null ? seedGear() : normaliseGear(raw);
      return gearCache;
    },
    save: function (g) {
      gearCache = normaliseGear(g);
      write(KEY_GEAR, gearCache);
      return gearCache;
    },
    reset: function () {
      remove(KEY_GEAR);
      gearCache = null;
      return gear.all();
    },
    uid: uid,

    scopes: function () { return gear.all().scopes; },
    cameras: function () { return gear.all().cameras; },
    reducers: function () { return gear.all().reducers; },
    rigs: function () { return gear.all().rigs; },

    findScope: function (id) { return gear.scopes().filter(function (x) { return x.id === id; })[0] || null; },
    findCamera: function (id) { return gear.cameras().filter(function (x) { return x.id === id; })[0] || null; },
    findReducer: function (id) { return gear.reducers().filter(function (x) { return x.id === id; })[0] || null; },

    /*
     * Turn a saved rig into the numbers every tool actually needs. Returns null
     * when a component has been deleted out from under the rig, so callers can
     * skip it rather than render NaN.
     */
    resolve: function (rigOrId) {
      var g = gear.all();
      var rig = typeof rigOrId === 'string'
        ? g.rigs.filter(function (r) { return r.id === rigOrId; })[0]
        : rigOrId;
      if (!rig) return null;

      var s = gear.findScope(rig.scopeId);
      var c = gear.findCamera(rig.cameraId);
      var rd = gear.findReducer(rig.reducerId) || { name: 'None (native)', v: 1 };
      if (!s || !c) return null;

      var ap = +s.ap, flNative = +s.fl, mult = +rd.v || 1;
      var px = +c.px, pw = +c.pw, ph = +c.ph;
      if (!(flNative > 0) || !(px > 0) || !(pw > 0) || !(ph > 0)) return null;

      var fl = flNative * mult;
      var wmm = pw * px / 1000;
      var hmm = ph * px / 1000;
      var DEG = 180 / Math.PI;

      var cat = rig.category || suggestCategory(fl);
      return {
        id: rig.id,
        name: rig.name || (s.name + ' · ' + c.name),
        category: cat,
        categoryName: categoryName(cat),
        scope: s, camera: c, reducer: rd,
        ap: ap,
        flNative: flNative,
        red: mult,
        fl: fl,
        fratio: ap > 0 ? fl / ap : null,
        px: px, pw: pw, ph: ph,
        wmm: wmm, hmm: hmm,
        scale: 206.265 * px / fl,                       /* arcsec per pixel */
        fovW: 2 * Math.atan(wmm / 2 / fl) * DEG,          /* degrees */
        fovH: 2 * Math.atan(hmm / 2 / fl) * DEG
      };
    },

    /* every rig that still resolves, in saved order */
    resolvedRigs: function () {
      return gear.rigs().map(gear.resolve).filter(Boolean);
    },

    active: function () {
      var g = gear.all();
      var r = g.activeRigId ? gear.resolve(g.activeRigId) : null;
      if (r) return r;
      var list = gear.resolvedRigs();
      return list.length ? list[0] : null;
    },

    setActive: function (id) {
      var g = gear.all();
      g.activeRigId = id || null;
      gear.save(g);
    },

    categories: CATEGORIES,
    suggestCategory: suggestCategory,
    categoryName: categoryName,

    /* resolved rigs grouped into category order, for optgroup-style pickers */
    byCategory: function () {
      var rigs = gear.resolvedRigs();
      return CATEGORIES.map(function (c) {
        return { id: c.id, name: c.name, rigs: rigs.filter(function (r) { return r.category === c.id; }) };
      }).filter(function (g) { return g.rigs.length; });
    },

    /* short one-line summary used in dropdown labels and pills */
    label: function (r) {
      if (!r) return '';
      var f = r.fratio ? ' f/' + r.fratio.toFixed(1).replace(/\.0$/, '') : '';
      return r.name + ' — ' + Math.round(r.fl) + 'mm' + f;
    }
  };

  /* ---------------- per-tool preferences ---------------- */

  /*
   * Tools compute from their form inputs on load, so restoring a saved value
   * silently would leave the readouts showing defaults. restore() therefore
   * dispatches the same events a person typing would, letting each tool's
   * existing listeners recalculate without any changes to their own code.
   */
  var prefs = {
    get: function (tool, fallback) { return read(PREF_PREFIX + tool, fallback); },
    set: function (tool, value) { write(PREF_PREFIX + tool, value); },
    clear: function (tool) { remove(PREF_PREFIX + tool); },

    /* capture the current value of each element id into storage */
    capture: function (tool, ids) {
      var out = {};
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        out[id] = el.type === 'checkbox' ? !!el.checked : el.value;
      });
      prefs.set(tool, out);
    },

    /* restore saved values and fire events so the tool recomputes */
    restore: function (tool, ids) {
      var saved = prefs.get(tool, null);
      if (!saved) return false;
      var touched = false;
      ids.forEach(function (id) {
        if (!(id in saved)) return;
        var el = document.getElementById(id);
        if (!el) return;
        var val = saved[id];
        try {
          if (el.type === 'checkbox') {
            if (el.checked === !!val) return;
            el.checked = !!val;
          } else {
            if (el.value === val) return;
            /* don't restore a select value whose option no longer exists */
            if (el.tagName === 'SELECT') {
              var ok = Array.prototype.some.call(el.options, function (o) { return o.value === val; });
              if (!ok) return;
            }
            el.value = val;
          }
          el.dispatchEvent(new Event(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', { bubbles: true }));
          touched = true;
        } catch (e) { /* skip anything that refuses to take the value */ }
      });
      return touched;
    },

    /* restore now, then save on every subsequent change */
    bind: function (tool, ids) {
      var restored = prefs.restore(tool, ids);
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        var save = function () { prefs.capture(tool, ids); };
        el.addEventListener('change', save);
        if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.addEventListener('input', save);
      });
      return restored;
    }
  };

  /* ---------------- shared gear picker ---------------- */

  /*
   * Every tool asks for the same three numbers in its own words -- focal
   * length, pixel size, sensor dimensions. Rather than teach each tool's
   * existing dropdowns about saved gear (six selects, four different value
   * encodings), each tool mounts this one picker and supplies a small adapter
   * that pushes the chosen rig into its own fields.
   *
   * The picker applies the active rig on load, so opening any tool already has
   * your gear dialled in. Equipment fields are therefore owned by the gear
   * library; per-tool preferences deliberately cover only the other settings
   * (seeing, sky quality, binning, survey…) so the two never fight.
   */
  var pickerStyled = false;
  function injectPickerStyle() {
    if (pickerStyled) return;
    pickerStyled = true;
    var css =
      '.wvo-gear-pick{display:block;margin:0 0 .9rem}' +
      '.wvo-gear-pick .wvo-gp-lab{display:flex;align-items:baseline;justify-content:space-between;gap:.6rem;' +
        'font-family:"JetBrains Mono",monospace;font-size:.6rem;letter-spacing:.18em;text-transform:uppercase;' +
        'color:#c9a84c;margin-bottom:.35rem}' +
      '.wvo-gear-pick a{color:#9a958d;text-decoration:none;border-bottom:1px solid rgba(154,149,141,.35);' +
        'font-size:.58rem;letter-spacing:.12em;white-space:nowrap}' +
      '.wvo-gear-pick a:active{color:#c9a84c}' +
      '.wvo-gear-pick select{width:100%;padding:.5rem .65rem;border-radius:8px;' +
        'background:#10131b;color:#e8e4df;border:1px solid rgba(201,168,76,.28);font-size:.85rem;font-family:inherit}' +
      '.wvo-gear-pick select:focus{outline:none;border-color:rgba(201,168,76,.6)}' +
      '.wvo-gp-meta{font-family:"JetBrains Mono",monospace;font-size:.62rem;color:#5a564f;margin-top:.3rem;min-height:1em}';
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  /*
   * mount   element the picker is inserted before (or appended to, see `where`)
   * onPick  fn(resolvedRig) -- push the rig into the tool's own fields
   * label   heading text, defaults to "My rig"
   * where   'before' (default) | 'prepend' | 'append'
   */
  function gearPicker(mount, onPick, options) {
    if (!mount) return null;
    options = options || {};
    injectPickerStyle();

    var wrap = document.createElement('div');
    wrap.className = 'wvo-gear-pick';

    var lab = document.createElement('div');
    lab.className = 'wvo-gp-lab';
    var labText = document.createElement('span');
    labText.textContent = options.label || 'My rig';
    var manage = document.createElement('a');
    manage.href = 'gear.html';
    manage.textContent = 'Manage gear';
    lab.appendChild(labText);
    lab.appendChild(manage);

    var sel = document.createElement('select');
    var meta = document.createElement('div');
    meta.className = 'wvo-gp-meta';

    wrap.appendChild(lab);
    wrap.appendChild(sel);
    wrap.appendChild(meta);

    function refresh() {
      var groups = gear.byCategory();
      var act = gear.active();
      sel.innerHTML = '';
      if (!groups.length) {
        var o = document.createElement('option');
        o.value = ''; o.textContent = 'No rigs saved — tap Manage gear';
        sel.appendChild(o);
        sel.disabled = true;
        meta.textContent = '';
        return null;
      }
      sel.disabled = false;
      /* grouped by framing class so "what's my wide option" is one glance */
      groups.forEach(function (g) {
        var og = document.createElement('optgroup');
        og.label = g.name;
        g.rigs.forEach(function (r) {
          var o = document.createElement('option');
          o.value = r.id; o.textContent = r.name;
          og.appendChild(o);
        });
        sel.appendChild(og);
      });
      if (act) sel.value = act.id;
      return act;
    }

    function describe(r) {
      if (!r) { meta.textContent = ''; return; }
      var f = r.fratio ? ' f/' + r.fratio.toFixed(1).replace(/\.0$/, '') : '';
      meta.textContent = r.categoryName + ' · ' + Math.round(r.fl) + 'mm' + f +
        ' · ' + r.scale.toFixed(2) + '″/px' +
        ' · ' + r.fovW.toFixed(2) + '° × ' + r.fovH.toFixed(2) + '°';
    }

    var active = refresh();
    describe(active);

    sel.addEventListener('change', function () {
      if (!sel.value) return;
      gear.setActive(sel.value);
      var r = gear.resolve(sel.value);
      describe(r);
      if (r && onPick) onPick(r);
    });

    var where = options.where || 'before';
    if (where === 'prepend') mount.insertBefore(wrap, mount.firstChild);
    else if (where === 'append') mount.appendChild(wrap);
    else mount.parentNode.insertBefore(wrap, mount);

    /* apply the active rig straight away so the tool opens ready to use */
    if (active && onPick && options.applyNow !== false) onPick(active);

    return { el: wrap, select: sel, refresh: refresh, active: function () { return gear.active(); } };
  }

  /* ---------------- expose + early night-mode paint ---------------- */

  global.WVO = {
    read: read, write: write, remove: remove, uid: uid,
    site: site, night: night, gear: gear, prefs: prefs,
    gearPicker: gearPicker
  };

  night.apply();
})(window);
