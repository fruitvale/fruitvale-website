/* ==========================================================================
   Fruitvale Optometry — insurance pre-screening gate
   Language-neutral logic. Per-page strings/config come from data-* attributes
   on #gate-root (so the same file serves the EN and ES pages).

   NO PHI is stored by this script. It validates format, POSTs to the office
   intake endpoint, and forwards to the existing 4PatientCare booking link.
   ========================================================================== */
(function () {
  "use strict";

  var root = document.getElementById("gate-root");
  if (!root) return;

  // ---- config from the page -------------------------------------------------
  var BOOKING_URL = root.getAttribute("data-booking-url");
  // The gate submits into a Google Form (whose responses land in a Sheet in the
  // office's HIPAA-BAA Workspace). FORM_ACTION = the form's /formResponse URL;
  // FORM_ENTRY = the "entry.NNN" field id of the single "data" question.
  var FORM_ACTION = root.getAttribute("data-form-action") || "";
  var FORM_ENTRY  = root.getAttribute("data-form-entry")  || "";
  var INTAKE_TIMEOUT_MS = 12000;

  // localized strings (set as data-* on #gate-root)
  var S = {
    required:  root.getAttribute("data-msg-required")  || "This field is required.",
    badCin:    root.getAttribute("data-msg-badcin")    || "Enter a valid CIN (8 digits and a letter, e.g. 91234567A).",
    badEyemed: root.getAttribute("data-msg-badeyemed") || "Enter your full EyeMed member ID (at least 9 digits).",
    badVspId:  root.getAttribute("data-msg-badvspid")  || "Enter the last 4 digits of the SSN or your VSP member ID.",
    badDob:    root.getAttribute("data-msg-baddob")    || "Enter a valid date of birth.",
    pickOne:   root.getAttribute("data-msg-pickone")   || "Please choose at least one option."
  };

  // ---- validation regexes (match the office engines) ------------------------
  // Medi-Cal: 9-char CIN (8 digits + letter), or the full BIC (CIN + up to 5
  // trailing digits). We keep only the first 9 (the CIN) when saving.
  var RE_CIN    = /^\d{8}[A-Za-z]\d{0,5}$/;
  var RE_EYEMED = /^\d{9,}$/;                 // full EyeMed member ID
  var RE_VSP_ID = /^[A-Za-z0-9]{4,17}$/;      // last-4 SSN or alphanumeric VSP unique ID

  var norm = function (v) { return (v || "").replace(/\s+/g, "").toUpperCase(); };

  // ---- element refs ---------------------------------------------------------
  var carrierBoxes = Array.prototype.slice.call(root.querySelectorAll(".carrier-option input"));
  var submitBtn = root.querySelector(".gate-submit");
  var form = root.querySelector("#gate-form");
  var modal = document.getElementById("gate-modal");
  var modalContinue = document.getElementById("gate-continue");

  // ---- carrier group show/hide + exclusivity of "none" ----------------------
  function selectedCarriers() {
    return carrierBoxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
  }

  function refreshGroups() {
    var none = carrierBoxes.filter(function (b) { return b.value === "none" && b.checked; }).length > 0;
    var anyReal = carrierBoxes.some(function (b) { return b.value !== "none" && b.checked; });

    carrierBoxes.forEach(function (b) {
      // "No insurance" is mutually exclusive with the others
      if (none && b.value !== "none") { b.checked = false; }
      var label = b.closest(".carrier-option");
      if (label) label.classList.toggle("checked", b.checked);
    });

    var clearState = function (group) {
      group.querySelectorAll("input").forEach(function (inp) {
        inp.classList.remove("invalid", "valid");
        var f = inp.closest(".field"); if (f) f.classList.remove("errored");
      });
    };

    // shared identity block: shown whenever a real carrier is selected
    var identity = root.querySelector(".identity-fields");
    if (identity) {
      identity.classList.toggle("show", anyReal && !none);
      if (!(anyReal && !none)) clearState(identity);
    }

    ["medical", "vsp", "eyemed"].forEach(function (key) {
      var group = root.querySelector('.carrier-fields[data-carrier="' + key + '"]');
      if (!group) return;
      var on = !none && carrierBoxes.some(function (b) { return b.value === key && b.checked; });
      group.classList.toggle("show", on);
      if (!on) clearState(group);   // hidden groups must not block submit
    });
    updateSubmitState();
  }

  // ---- per-field validation -------------------------------------------------
  function validateField(inp, showErr) {
    var type = inp.getAttribute("data-validate");
    var raw = inp.value;
    var val = norm(raw);
    var ok = true, msg = "";

    if (type === "required") {
      ok = raw.trim().length > 0; msg = S.required;
    } else if (type === "cin") {
      if (!val) { ok = false; msg = S.required; }
      else { ok = RE_CIN.test(val); msg = S.badCin; }
    } else if (type === "eyemed") {
      if (!val) { ok = false; msg = S.required; }
      else { ok = RE_EYEMED.test(val); msg = S.badEyemed; }
    } else if (type === "vspid") {
      if (!val) { ok = false; msg = S.required; }
      else { ok = RE_VSP_ID.test(val); msg = S.badVspId; }
    } else if (type === "dob") {
      ok = validDob(raw); msg = raw.trim() ? S.badDob : S.required;
    }

    var field = inp.closest(".field");
    inp.classList.toggle("valid", ok && raw.trim().length > 0);
    inp.classList.toggle("invalid", !ok && (showErr || raw.trim().length > 0));
    if (field) {
      var em = field.querySelector(".error-msg");
      if (em) em.textContent = msg;
      field.classList.toggle("errored", !ok && showErr);
    }
    return ok;
  }

  function validDob(raw) {
    if (!raw) return false;
    var d = new Date(raw);                       // <input type="date"> gives YYYY-MM-DD
    if (isNaN(d.getTime())) return false;
    var now = new Date();
    if (d > now) return false;
    var age = (now - d) / (365.25 * 24 * 3600 * 1000);
    return age >= 0 && age <= 120;
  }

  function activeInputs() {
    var out = [];
    root.querySelectorAll(".identity-fields.show input, .carrier-fields.show input").forEach(function (inp) { out.push(inp); });
    return out;
  }

  function formValid() {
    var carriers = selectedCarriers();
    if (carriers.length === 0) return false;
    if (carriers.indexOf("none") !== -1) return true;         // no-insurance: nothing to fill
    var inputs = activeInputs();
    if (inputs.length === 0) return false;
    return inputs.every(function (inp) { return validateField(inp, false); });
  }

  function updateSubmitState() {
    submitBtn.disabled = !formValid();
  }

  // ---- payload (no PHI kept anywhere but the request body) ------------------
  function buildPayload() {
    var carriers = selectedCarriers();
    var p = { carriers: carriers };
    // shared identity (used to match the booking confirmation)
    p.identity = {
      first: val("id-first").trim(),
      last:  val("id-last").trim(),
      dob:   val("id-dob")
    };
    if (carriers.indexOf("medical") !== -1) {
      var cin = norm(val("medical-cin"));
      p.medical = { cin: cin, cin9: cin.slice(0, 9) };        // cin9 = what the engine's subscriberID needs
    }
    if (carriers.indexOf("vsp") !== -1) {
      p.vsp = { id: norm(val("vsp-id")) };
    }
    if (carriers.indexOf("eyemed") !== -1) {
      p.eyemed = { memberId: norm(val("eyemed-id")) };
    }
    return p;
  }

  function val(id) { var el = document.getElementById(id); return el ? el.value : ""; }

  // ---- submit ---------------------------------------------------------------
  form.addEventListener("submit", function (e) {
    e.preventDefault();

    // hard block: re-validate every visible field, show errors
    var carriers = selectedCarriers();
    if (carriers.length === 0) return;

    if (carriers.indexOf("none") !== -1) {           // no insurance -> straight to booking
      go(BOOKING_URL);
      return;
    }

    var inputs = activeInputs();
    var allOk = true;
    inputs.forEach(function (inp) { if (!validateField(inp, true)) allOk = false; });
    if (!allOk) {
      var firstBad = root.querySelector(".identity-fields.show input.invalid, .carrier-fields.show input.invalid");
      if (firstBad) firstBad.focus();
      return;
    }

    submitBtn.disabled = true;
    submitBtn.classList.add("is-loading");

    postIntake(buildPayload())
      .then(function () { showModal(); })       // saved
      .catch(function () { showModal(); })      // fail-open: still let them book
      .then(function () {
        submitBtn.disabled = false;
        submitBtn.classList.remove("is-loading");
      });
  });

  function postIntake(payload) {
    if (!FORM_ACTION || !FORM_ENTRY) return Promise.reject(new Error("no-endpoint"));  // fail-open
    // Google Forms' formResponse endpoint: url-encoded, no CORS headers, so we
    // send it "no-cors" (opaque — we can't read the result, but the response is
    // recorded). The whole gate payload rides in the single "data" field as JSON.
    var body = new URLSearchParams();
    body.append(FORM_ENTRY, JSON.stringify(payload));
    var ctrl = ("AbortController" in window) ? new AbortController() : null;
    var t = ctrl ? setTimeout(function () { ctrl.abort(); }, INTAKE_TIMEOUT_MS) : null;
    return fetch(FORM_ACTION, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: ctrl ? ctrl.signal : undefined
    }).then(function (r) {
      if (t) clearTimeout(t);
      return r;   // opaque response = submitted; success either way -> show popup
    });
  }

  // ---- confirmation popup ---------------------------------------------------
  function showModal() {
    if (!modal) { go(BOOKING_URL); return; }
    modal.classList.add("open");
    if (modalContinue) modalContinue.focus();
  }
  if (modalContinue) {
    modalContinue.addEventListener("click", function () { go(BOOKING_URL); });
  }

  function go(url) { window.location.href = url; }

  // ---- wire events ----------------------------------------------------------
  carrierBoxes.forEach(function (b) { b.addEventListener("change", refreshGroups); });

  // Name fields: letters only (plus space, hyphen, apostrophe, period for names
  // like "Mary-Jane", "O'Brien", "Jr."). Strip digits and other symbols as the
  // user types. Registered BEFORE the validation listener so it sees clean text.
  var NAME_BLOCK = /[^\p{L}\s'’.\-]/gu;   // anything that's not a letter/space/'/’/./-
  ["id-first", "id-last"].forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener("input", function () {
      var clean = el.value.replace(NAME_BLOCK, "");
      if (clean !== el.value) {
        var drop = el.value.length - clean.length;
        var pos = Math.max(0, (el.selectionStart || clean.length) - drop);
        el.value = clean;
        try { el.setSelectionRange(pos, pos); } catch (e) { /* number inputs etc. */ }
      }
    });
  });

  // Wire the identity block (first/last/DOB) as well as the carrier fields --
  // otherwise editing name/DOB never re-checks the submit button, so filling or
  // fixing an identity field last leaves the button stuck disabled even though
  // every field is valid.
  root.querySelectorAll(".identity-fields input, .carrier-fields input").forEach(function (inp) {
    inp.addEventListener("input", function () { validateField(inp, false); updateSubmitState(); });
    inp.addEventListener("blur",  function () { validateField(inp, true); });
  });

  refreshGroups();
})();
