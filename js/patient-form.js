/* ==========================================================================
   Fruitvale Optometry — online "Patient Information" (HIPAA) form
   Serves patient-form.html (EN) and es/formulario-paciente.html (ES); the
   language comes from data-lang on #pf-root, labels live in the HTML.

   Where the answers go: the whole form is packed into ONE JSON string and
   POSTed straight from the patient's browser to a Google Form (responses land
   in a Sheet in the office's HIPAA-BAA Google Workspace). The website itself
   (Cloudflare) never sees the answers. Nothing is kept on the device: no
   localStorage, no cookies, and the page reloads clean after "Done".

   Debugging: add ?debug=1 to the URL to log each step to the console. The
   log only ever carries field NAMES, counts and sizes -- never what was typed.
   ========================================================================== */
(function () {
  "use strict";

  var root = document.getElementById("pf-root");
  if (!root) return;

  var DEBUG = /[?&]debug=1\b/.test(location.search);
  function dbg() {
    if (!DEBUG || !window.console) return;
    var a = Array.prototype.slice.call(arguments);
    a.unshift("[pf " + new Date().toISOString().slice(11, 23) + "]");
    console.log.apply(console, a);
  }

  var LANG = root.getAttribute("data-lang") || "en";
  var FORM_ACTION = root.getAttribute("data-form-action") || "";
  var FORM_ENTRY  = root.getAttribute("data-form-entry")  || "";
  var NOTICE_VER  = root.getAttribute("data-notice-version") || "";
  var POST_TIMEOUT_MS = 15000;
  // Sheets holds at most 50,000 characters per cell. Keep a wide margin.
  var MAX_PAYLOAD = 40000;

  var T = {
    en: {
      required: "This field is required.",
      name: "Use letters only.",
      dob: "Enter the date as MM/DD/YYYY.",
      dobFuture: "That date is in the future.",
      zip: "Enter a 5-digit ZIP code.",
      state: "Use the 2-letter state, like CA.",
      phone: "Enter a 10-digit phone number.",
      email: "That email doesn't look right.",
      ssn: "Enter all 9 digits, like 123-45-6789.",
      year: "Enter a 4-digit year.",
      mi: "One letter.",
      agree: "Please check the box to agree.",
      sign: "Please sign in the box.",
      fixOne: "Please fix the highlighted question above.",
      fixMany: "Please fix the {n} highlighted questions above.",
      sending: "Sending…",
      tooBig: "Your signature is too detailed to send. Please tap \"Clear signature\" and sign again a little more simply.",
      sendFail: "We couldn't reach the internet. Check your connection and tap Submit again, or ask the front desk for a paper form.",
      leave: "You haven't sent your form yet. Leave anyway?"
    },
    es: {
      required: "Esta pregunta es obligatoria.",
      name: "Use solo letras.",
      dob: "Escriba la fecha como MM/DD/AAAA.",
      dobFuture: "Esa fecha es en el futuro.",
      zip: "Escriba un código postal de 5 dígitos.",
      state: "Use las 2 letras del estado, como CA.",
      phone: "Escriba un teléfono de 10 dígitos.",
      email: "Ese correo no parece correcto.",
      ssn: "Escriba los 9 dígitos, como 123-45-6789.",
      year: "Escriba un año de 4 dígitos.",
      mi: "Una letra.",
      agree: "Marque la casilla para aceptar.",
      sign: "Por favor firme en el recuadro.",
      fixOne: "Por favor corrija la pregunta marcada arriba.",
      fixMany: "Por favor corrija las {n} preguntas marcadas arriba.",
      sending: "Enviando…",
      tooBig: "Su firma tiene demasiados trazos para enviarla. Toque \"Borrar firma\" y firme otra vez un poco más simple.",
      sendFail: "No pudimos conectarnos a internet. Revise su conexión y toque Enviar otra vez, o pida un formulario en papel en la recepción.",
      leave: "Todavía no ha enviado su formulario. ¿Salir de todos modos?"
    }
  }[LANG] || null;
  if (!T) T = { required: "Required." };

  var form = document.getElementById("pf-form");
  var submitBtn = document.getElementById("pf-submit");
  var summary = document.getElementById("pf-summary");
  var modal = document.getElementById("pf-modal");
  var dirty = false, sent = false;

  // ---- tiny helpers ---------------------------------------------------------
  function $(id) { return document.getElementById(id); }
  function val(id) { var el = $(id); return el ? String(el.value || "").trim() : ""; }
  function checkedVals(name) {
    return Array.prototype.slice.call(form.querySelectorAll('input[name="' + name + '"]:checked'))
      .map(function (b) { return b.value; });
  }
  function radioVal(name) { var v = checkedVals(name); return v.length ? v[0] : ""; }
  // only while its block is showing: a block hidden again keeps what was typed in it
  function shownVal(id) { var el = $(id); return el && isActive(el) ? val(id) : ""; }
  function shownRadio(name) {
    var el = form.querySelector('input[name="' + name + '"]');
    return el && isActive(el) ? radioVal(name) : "";
  }
  function shownChecked(name) {
    var el = form.querySelector('input[name="' + name + '"]');
    return el && isActive(el) ? checkedVals(name) : [];
  }
  function digits(s) { return String(s || "").replace(/\D/g, ""); }
  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  // An element counts only when every .pf-when it sits inside is showing --
  // a hidden block's required fields must never block the submit.
  function isActive(el) {
    var w = el.closest(".pf-when");
    while (w) {
      if (!w.classList.contains("show")) return false;
      w = w.parentElement ? w.parentElement.closest(".pf-when") : null;
    }
    return true;
  }

  // ---- today's date on the signature line ----------------------------------
  var now0 = new Date();
  var todayStr = pad2(now0.getMonth() + 1) + "/" + pad2(now0.getDate()) + "/" + now0.getFullYear();
  if ($("pf-today")) $("pf-today").textContent = todayStr;

  // ---- chips: keep the .checked look in sync, "none" is exclusive ----------
  var chipInputs = Array.prototype.slice.call(form.querySelectorAll(".pf-chip input, .pf-agree input"));
  function syncChips() {
    chipInputs.forEach(function (inp) {
      var lab = inp.closest(".pf-chip, .pf-agree");
      if (lab) lab.classList.toggle("checked", inp.checked);
    });
  }
  chipInputs.forEach(function (inp) {
    inp.addEventListener("change", function () {
      if (inp.type === "checkbox" && inp.checked) {
        var group = form.querySelectorAll('input[name="' + inp.name + '"]');
        Array.prototype.forEach.call(group, function (o) {
          if (o === inp) return;
          // ticking "none" clears the rest; ticking anything clears "none"
          if (inp.hasAttribute("data-exclusive") || o.hasAttribute("data-exclusive")) o.checked = false;
        });
      }
      dirty = true;
      syncChips();
      refreshWhen();
      var g = inp.closest("[data-req-group]");
      if (g) g.classList.remove("errored");
      if (inp.id === "pf-agree") $("pf-agree-label").classList.remove("errored");
    });
  });

  // ---- show/hide blocks: data-when="name:value[,value...]" -----------------
  // "name:!value" = shown UNLESS that value is picked (also while nothing is) --
  // the health questions hide for a "New glasses" visit (user 10/27/2026)
  var whens = Array.prototype.slice.call(form.querySelectorAll("[data-when]"));
  function refreshWhen() {
    whens.forEach(function (el) {
      var spec = el.getAttribute("data-when").split(":");
      var picked = checkedVals(spec[0]);
      var not = (spec[1] || "").charAt(0) === "!";
      var want = (spec[1] || "").replace(/^!/, "").split(",");
      var hit = want.some(function (w) { return picked.indexOf(w) !== -1; });
      var on = not ? !hit : hit;
      if (el.classList.contains("show") !== on) dbg("block", el.getAttribute("data-when"), on ? "shown" : "hidden");
      el.classList.toggle("show", on);
    });
  }

  // ---- as-you-type formatting ----------------------------------------------
  function fmtDate(el) {
    var d = digits(el.value).slice(0, 8), out = d;
    if (d.length > 4) out = d.slice(0, 2) + "/" + d.slice(2, 4) + "/" + d.slice(4);
    else if (d.length > 2) out = d.slice(0, 2) + "/" + d.slice(2);
    if (out !== el.value) el.value = out;
  }
  function fmtPhone(el) {
    var d = digits(el.value);
    if (d.length === 11 && d.charAt(0) === "1") d = d.slice(1);
    d = d.slice(0, 10);
    var out = d;
    if (d.length > 6) out = "(" + d.slice(0, 3) + ") " + d.slice(3, 6) + "-" + d.slice(6);
    else if (d.length > 3) out = "(" + d.slice(0, 3) + ") " + d.slice(3);
    if (out !== el.value) el.value = out;
  }
  function fmtSsn(el) {
    var d = digits(el.value).slice(0, 9), out = d;
    if (d.length > 5) out = d.slice(0, 3) + "-" + d.slice(3, 5) + "-" + d.slice(5);
    else if (d.length > 3) out = d.slice(0, 3) + "-" + d.slice(3);
    if (out !== el.value) el.value = out;
  }
  var NAME_BLOCK = /[^\p{L}\s'’.\-]/gu;     // letters, space, ' ’ . - only (Mary-Jane, O'Brien, Jr.)
  form.querySelectorAll("input[data-validate]").forEach(function (inp) {
    var kind = inp.getAttribute("data-validate");
    inp.addEventListener("input", function () {
      if (kind === "dob") fmtDate(inp);
      else if (kind === "phone") fmtPhone(inp);
      else if (kind === "ssn") fmtSsn(inp);
      else if (kind === "name" || kind === "mi") {
        var clean = inp.value.replace(NAME_BLOCK, "");
        if (clean !== inp.value) inp.value = clean;
      } else if (kind === "state") {
        var up = inp.value.toUpperCase();
        if (up !== inp.value) inp.value = up;
      } else if (kind === "zip" || kind === "year") {
        var dd = inp.value.replace(/[^\d-]/g, "");
        if (dd !== inp.value) inp.value = dd;
      }
    });
  });
  form.addEventListener("input", function () { dirty = true; });

  // ---- validation -----------------------------------------------------------
  var RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

  function checkDate(raw) {
    var m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
    if (!m) return T.dob;
    var mo = +m[1], da = +m[2], yr = +m[3];
    var d = new Date(yr, mo - 1, da);
    if (d.getFullYear() !== yr || d.getMonth() !== mo - 1 || d.getDate() !== da) return T.dob;
    if (d > new Date()) return T.dobFuture;
    if (yr < new Date().getFullYear() - 120) return T.dob;
    return "";
  }

  // returns "" when fine, else the message to show
  function fieldError(inp) {
    var raw = String(inp.value || "").trim();
    var kind = inp.getAttribute("data-validate") || "";
    if (!raw) return inp.hasAttribute("data-req") ? T.required : "";
    switch (kind) {
      case "name":  return /\p{L}/u.test(raw) ? "" : T.name;
      case "mi":    return /^\p{L}$/u.test(raw) ? "" : T.mi;
      case "dob":   return checkDate(raw);
      case "zip":   return /^\d{5}(-?\d{4})?$/.test(raw) ? "" : T.zip;
      case "state": return /^[A-Z]{2}$/.test(raw) ? "" : T.state;
      case "phone": return digits(raw).length === 10 ? "" : T.phone;
      case "email": return RE_EMAIL.test(raw) ? "" : T.email;
      case "ssn":   return digits(raw).length === 9 ? "" : T.ssn;
      case "year":  return (/^\d{4}$/.test(raw) && +raw <= new Date().getFullYear() && +raw > 1900) ? "" : T.year;
    }
    return "";
  }

  function showFieldError(inp, msg, loud) {
    var f = inp.closest(".field");
    inp.classList.toggle("invalid", !!msg && loud);
    inp.classList.toggle("valid", !msg && !!String(inp.value || "").trim());
    if (f) {
      var em = f.querySelector(".error-msg");
      if (em) em.textContent = msg || "";
      f.classList.toggle("errored", !!msg && loud);
    }
  }

  form.querySelectorAll(".field input, .field select, .field textarea").forEach(function (inp) {
    inp.addEventListener("blur", function () {
      if (!isActive(inp)) return;
      var msg = fieldError(inp);
      // on blur, only nag about a field they actually typed in
      if (String(inp.value || "").trim() || inp.closest(".field").classList.contains("errored")) showFieldError(inp, msg, true);
    });
    inp.addEventListener("input", function () {
      if (inp.closest(".field").classList.contains("errored") && !fieldError(inp)) showFieldError(inp, "", true);
    });
  });

  function validateAll() {
    var bad = [];
    form.querySelectorAll(".field input, .field select, .field textarea").forEach(function (inp) {
      if (!isActive(inp)) { showFieldError(inp, "", false); return; }
      var msg = fieldError(inp);
      showFieldError(inp, msg, true);
      if (msg) bad.push(inp);
    });
    form.querySelectorAll("[data-req-group]").forEach(function (g) {
      var name = g.getAttribute("data-req-group");
      var ok = !isActive(g) || checkedVals(name).length > 0;
      g.classList.toggle("errored", !ok);
      if (!ok) bad.push(g);
    });
    var agree = $("pf-agree");
    var agreeOk = agree.checked;
    $("pf-agree-label").classList.toggle("errored", !agreeOk);
    if (!agreeOk) bad.push($("pf-agree-label"));
    var sigOk = sig.hasInk();
    $("pf-sig-wrap").classList.toggle("errored", !sigOk);
    if (!sigOk) bad.push($("pf-sig-wrap"));
    // document order, so "first problem" really is the first one on screen
    bad.sort(function (a, b) { return a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1; });
    dbg("validate:", bad.length, "problem(s)", bad.map(function (e) { return e.id || e.getAttribute("data-req-group") || e.className; }));
    return bad;
  }

  // ---- signature pad --------------------------------------------------------
  // Strokes are kept in a fixed 1000 x 500 space (the box is always 2:1, see
  // .pf-sig-wrap), so the office PDF can redraw them exactly whatever size the
  // phone screen was. w/h ride along in the payload.
  var sig = (function () {
    var VW = 1000, VH = 500;
    var canvas = $("pf-sig"), wrap = $("pf-sig-wrap");
    var ctx = canvas.getContext("2d");
    var strokes = [], cur = null, drawing = false;

    function size() {
      var r = canvas.getBoundingClientRect();
      var dpr = window.devicePixelRatio || 1;
      canvas.width = Math.max(1, Math.round(r.width * dpr));
      canvas.height = Math.max(1, Math.round(r.height * dpr));
      redraw();
    }
    // Pointer capture keeps a finger that slides off the box still drawing, so
    // clamp to the box -- otherwise the saved strokes run off the PDF's box.
    function toV(e) {
      var r = canvas.getBoundingClientRect();
      var x = Math.round((e.clientX - r.left) / r.width * VW), y = Math.round((e.clientY - r.top) / r.height * VH);
      return [Math.min(VW, Math.max(0, x)), Math.min(VH, Math.max(0, y))];
    }
    function line(a, b) {
      var sx = canvas.width / VW, sy = canvas.height / VH;
      ctx.beginPath();
      ctx.moveTo(a[0] * sx, a[1] * sy);
      ctx.lineTo(b[0] * sx, b[1] * sy);
      ctx.stroke();
    }
    function style() {
      ctx.strokeStyle = "#10233a";
      ctx.lineWidth = Math.max(2, canvas.width / 260);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    function redraw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      style();
      strokes.forEach(function (s) {
        if (s.length === 1) line(s[0], [s[0][0] + 1, s[0][1]]);
        for (var i = 1; i < s.length; i++) line(s[i - 1], s[i]);
      });
    }
    canvas.addEventListener("pointerdown", function (e) {
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch (x) { /* old browsers */ }
      drawing = true;
      cur = [toV(e)];
      strokes.push(cur);
      style();
      line(cur[0], [cur[0][0] + 1, cur[0][1]]);
    });
    canvas.addEventListener("pointermove", function (e) {
      if (!drawing) return;
      e.preventDefault();
      var p = toV(e), last = cur[cur.length - 1];
      // skip points closer than 3 units -- keeps the saved signature small
      if (Math.abs(p[0] - last[0]) + Math.abs(p[1] - last[1]) < 3) return;
      cur.push(p);
      style();
      line(last, p);
    });
    function end() {
      if (!drawing) return;
      drawing = false;
      dirty = true;
      wrap.classList.toggle("has-ink", hasInk());
      if (hasInk()) wrap.classList.remove("errored");
      dbg("signature stroke done:", strokes.length, "stroke(s),", points(), "point(s)");
    }
    canvas.addEventListener("pointerup", end);
    canvas.addEventListener("pointercancel", end);
    canvas.addEventListener("pointerleave", end);

    function points() { return strokes.reduce(function (n, s) { return n + s.length; }, 0); }
    // a stray tap is not a signature: ask for a little real ink
    function hasInk() {
      var len = 0;
      strokes.forEach(function (s) {
        for (var i = 1; i < s.length; i++) len += Math.abs(s[i][0] - s[i - 1][0]) + Math.abs(s[i][1] - s[i - 1][1]);
      });
      return len >= 60;
    }
    function clear() {
      strokes = []; cur = null;
      redraw();
      wrap.classList.remove("has-ink");
      dbg("signature cleared");
    }
    // compact SVG-style path: "M12 40L15 42L19 45M..."
    function path(step) {
      step = step || 1;
      return strokes.map(function (s) {
        var pts = s.filter(function (p, i) { return i === 0 || i === s.length - 1 || i % step === 0; });
        return "M" + pts.map(function (p) { return p[0] + " " + p[1]; }).join("L");
      }).join("");
    }
    window.addEventListener("resize", size);
    size();
    return { hasInk: hasInk, clear: clear, path: path, points: points, VW: VW, VH: VH };
  })();
  $("pf-sig-clear").addEventListener("click", function () { sig.clear(); });

  // ---- submission id --------------------------------------------------------
  // Random, no patient information in it, and never shown to the patient (user
  // 10/27/2026: no confirmation code). The office tool uses it to tell
  // submissions apart and to remember which ones were filed in Crystal.
  var CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";   // no 0/O or 1/I
  function newCode() {
    var out = "", n = 6, i, buf;
    if (window.crypto && window.crypto.getRandomValues) {
      buf = new Uint8Array(n);
      window.crypto.getRandomValues(buf);
      for (i = 0; i < n; i++) out += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
    } else {
      for (i = 0; i < n; i++) out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    }
    return out;
  }

  function localIso(d) {
    var off = -d.getTimezoneOffset(), sgn = off >= 0 ? "+" : "-";
    off = Math.abs(off);
    return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()) + "T" + pad2(d.getHours()) + ":" +
      pad2(d.getMinutes()) + ":" + pad2(d.getSeconds()) + sgn + pad2(Math.floor(off / 60)) + ":" + pad2(off % 60);
  }

  // ---- the payload ------------------------------------------------------------
  // Keep the shape in sync with tools\patient_forms.py (it renders the PDF).
  function buildPayload(code, step) {
    var signer = radioVal("signer");
    var p = {
      v: 2,                  // 2 = has the health section (10/27/2026)
      form: "patient-info",
      lang: LANG,
      ref: code,
      notice: NOTICE_VER,
      at: localIso(new Date()),
      patient: {
        first: val("p-first"), last: val("p-last"), mi: val("p-mi").toUpperCase(),
        dob: val("p-dob"), sex: radioVal("p-sex"), pronouns: val("p-pronouns"),
        address: val("p-address"), apt: val("p-apt"), city: val("p-city"),
        state: val("p-state").toUpperCase(), zip: val("p-zip"),
        cell: val("p-cell"), work: val("p-work"), email: val("p-email"),
        occupation: val("p-occupation"), ssn: val("p-ssn")
      },
      // No insurance section any more (user 10/27/2026: "get rid of ... the
      // insurance part") -- the front desk gets that from the card at check-in.
      // No emergency contact either (user 10/27/2026: "get rid of the emergency contact").
      // The short health section (user 10/27/2026: the paper sheet's medical part,
      // "as simple as possible"). Codes, not words -- the office PDF turns them
      // into English whichever language the form was in.
      health: {
        reason: radioVal("h-reason"),
        eye: shownRadio("h-eye"), howLong: shownVal("h-howlong"), problem: shownVal("h-problem"),
        lastExam: radioVal("h-lastexam"),
        wear: checkedVals("h-wear"), wantsContacts: checkedVals("h-clint").length > 0,
        // the medical questions are hidden for a "New glasses" visit -> left out then
        meds: shownRadio("h-meds"), medsList: shownVal("h-meds-list"),
        allergies: shownRadio("h-allergy"), allergyList: shownVal("h-allergy-list"),
        conditions: shownChecked("h-cond"), diabetesYear: shownVal("h-dm-year"), insulin: shownRadio("h-insulin"),
        otherHealth: shownVal("h-cond-other"),
        eyeHistory: shownChecked("h-eyehx"), symptoms: shownChecked("h-sym"), family: shownChecked("h-fam"),
        smoking: shownRadio("h-smoke"), screens: radioVal("h-screen"),
        pcp: shownVal("h-pcp"), heard: radioVal("h-heard")
      },
      // The visit + health-history questions of the full paper sheet are left
      // out for now (user 10/27/2026: "just have the patient info part").
      sign: {
        by: signer,
        name: signer === "guardian" ? val("g-name") : (val("p-first") + " " + val("p-last")).trim(),
        rel: signer === "guardian" ? val("g-rel") : "",
        agreed: $("pf-agree").checked,
        // the exact words they agreed to, so the office PDF shows what was on screen
        ackText: ($("pf-ack-text").textContent || "").replace(/\s+/g, " ").trim(),
        date: todayStr,
        w: sig.VW, h: sig.VH,
        path: sig.path(step)
      }
    };
    return p;
  }

  // ---- send -----------------------------------------------------------------
  function post(json) {
    if (!FORM_ACTION || !FORM_ENTRY) return Promise.reject(new Error("no-endpoint"));
    // Google Forms' formResponse endpoint sends no CORS headers, so this goes
    // "no-cors": the response is opaque. A resolved fetch means the request
    // reached Google; a network failure rejects and we tell the patient.
    var body = new URLSearchParams();
    body.append(FORM_ENTRY, json);
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, POST_TIMEOUT_MS) : null;
    return fetch(FORM_ACTION, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) { if (t) clearTimeout(t); return r; },
            function (e) { if (t) clearTimeout(t); throw e; });
  }

  function setSummary(msg) {
    summary.textContent = msg || "";
    summary.classList.toggle("show", !!msg);
  }

  var btnLabel = submitBtn.textContent;
  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var t0 = Date.now();
    refreshWhen();
    var bad = validateAll();
    if (bad.length) {
      setSummary(bad.length === 1 ? T.fixOne : T.fixMany.replace("{n}", bad.length));
      var first = bad[0];
      first.scrollIntoView({ behavior: "smooth", block: "center" });
      var focusable = first.matches("input,select,textarea") ? first : first.querySelector("input");
      if (focusable) setTimeout(function () { try { focusable.focus({ preventScroll: true }); } catch (x) { focusable.focus(); } }, 350);
      return;
    }
    setSummary("");

    var code = newCode();
    var payload = buildPayload(code, 1), json = JSON.stringify(payload);
    // A very busy signature can blow past the cell limit: thin it out.
    for (var step = 2; json.length > MAX_PAYLOAD && step <= 6; step++) {
      payload = buildPayload(code, step);
      json = JSON.stringify(payload);
      dbg("payload too big, thinned signature to every", step, "points ->", json.length, "chars");
    }
    dbg("payload:", json.length, "chars, signature", payload.sign.path.length, "chars,", sig.points(), "points");
    if (json.length > MAX_PAYLOAD) { setSummary(T.tooBig); return; }

    submitBtn.disabled = true;
    submitBtn.classList.add("is-loading");
    submitBtn.textContent = T.sending;
    post(json).then(function () {
      dbg("posted OK in", Date.now() - t0, "ms");
      sent = true;
      modal.classList.add("open");
      $("pf-done").focus();
    }, function (err) {
      dbg("post FAILED:", err && err.name, err && err.message);
      setSummary(T.sendFail);
    }).then(function () {
      submitBtn.disabled = false;
      submitBtn.classList.remove("is-loading");
      submitBtn.textContent = btnLabel;
    });
  });

  // "Done": wipe everything (a shared office tablet must not show the last
  // patient's answers) by reloading the page fresh.
  $("pf-done").addEventListener("click", function () {
    dbg("done -> reload clean");
    form.reset();
    sig.clear();
    location.replace(location.pathname);
  });

  window.addEventListener("beforeunload", function (e) {
    if (dirty && !sent) { e.preventDefault(); e.returnValue = T.leave; return T.leave; }
  });

  syncChips();
  refreshWhen();
  dbg("ready: lang", LANG, "| endpoint", FORM_ACTION ? "set" : "MISSING", "| notice", NOTICE_VER);
})();
