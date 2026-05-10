// ── Stage resolution (separate from admin app) ─────────────────
const STAGES = {
  dev: "https://95gewohkpj.execute-api.eu-north-1.amazonaws.com/dev/llb/v1",
  prod: "https://eay07x2tc7.execute-api.eu-north-1.amazonaws.com/prod/llb/v1",
};
const PWD_KEY = "llAdminPwd";
const STAGE_KEY = "llCheckinStage";

function resolveStage() {
  try {
    var fromUrl = new URLSearchParams(window.location.search).get("stage");
    if (fromUrl && STAGES[fromUrl]) {
      sessionStorage.setItem(STAGE_KEY, fromUrl);
      return fromUrl;
    }
  } catch (e) {}
  try {
    var stored = sessionStorage.getItem(STAGE_KEY);
    if (stored && STAGES[stored]) return stored;
  } catch (e) {}
  return location.hostname.endsWith(".github.io") ? "prod" : "dev";
}
const STAGE = resolveStage();
const API_BASE = STAGES[STAGE];
document.body.classList.add("stage-" + STAGE);
(function initStageBadge() {
  var badge = document.getElementById("stageBadge");
  badge.textContent = STAGE.toUpperCase();
  badge.title = "Klicka för att byta miljö (just nu " + STAGE.toUpperCase() + ")";
  badge.addEventListener("click", function () {
    var next = STAGE === "prod" ? "dev" : "prod";
    if (!confirm("Byt miljö till " + next.toUpperCase() + " och ladda om sidan?")) return;
    try { sessionStorage.setItem(STAGE_KEY, next); } catch (e) {}
    var url = new URL(window.location.href);
    url.searchParams.delete("stage");
    window.location.replace(url.toString());
  });
})();

// ── Fetch wrapper that scrubs admin= and surfaces errorMsg ─────
function scrubUrl(url) {
  return String(url).replace(/admin=[^&]*/g, "admin=***");
}
function scrubMessage(msg) {
  return String(msg == null ? "" : msg).replace(/admin=[^&\s]*/g, "admin=***");
}
(function logFetches() {
  var orig = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || String(input);
    var method = (init && init.method) || (typeof input !== "string" && input && input.method) || "GET";
    console.log("[fetch]", method, scrubUrl(url));
    return orig.apply(this, arguments);
  };
})();

function fetchJson(url, init) {
  return fetch(url, init).then(function (res) {
    return res.text().then(function (text) {
      var body = null;
      if (text) { try { body = JSON.parse(text); } catch (e) {} }
      if (!res.ok) {
        var msg = (body && (body.errorMsg || body.message)) ||
          (text && text.length < 200 ? text : "") ||
          ("HTTP " + res.status);
        var err = new Error(scrubMessage(msg));
        err.status = res.status;
        err.body = body;
        console.error("[fetch error]", res.status, scrubUrl(url), body || text);
        throw err;
      }
      if (body && body.success === false) {
        var err2 = new Error(scrubMessage(body.errorMsg || body.errorCode || "Request failed"));
        err2.body = body;
        console.error("[api success:false]", scrubUrl(url), body);
        throw err2;
      }
      return body;
    });
  });
}

// ── HTML escaping ──────────────────────────────────────────────
function escapeHtml(str) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str == null ? "" : str));
  return div.innerHTML;
}
function escapeAttr(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Toasts ─────────────────────────────────────────────────────
var toastsEl = document.getElementById("toasts");
function showToast(message, opts) {
  opts = opts || {};
  var isError = !!opts.error;
  var isSticky = !!opts.sticky;
  var duration = opts.duration != null ? opts.duration : (isSticky ? 0 : (isError ? 5000 : 2500));
  var toast = document.createElement("div");
  toast.className = "toast" +
    (isError ? " toast-error" : (opts.success ? " toast-success" : "")) +
    (isSticky ? " toast-sticky" : "");
  toast.textContent = scrubMessage(message);
  if (isSticky) toast.addEventListener("click", function () { dismiss(); });
  toastsEl.appendChild(toast);
  requestAnimationFrame(function () { toast.classList.add("visible"); });
  function dismiss() {
    toast.classList.remove("visible");
    setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 200);
  }
  if (duration > 0) setTimeout(dismiss, duration);
  return dismiss;
}
function showError(msg, opts) { return showToast(msg, Object.assign({ error: true }, opts || {})); }
function showSuccess(msg) { return showToast(msg, { success: true, duration: 1800 }); }

// ── Time helpers (Europe/Stockholm) ────────────────────────────
function nowInStockholm() {
  var fmt = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  var parts = {};
  fmt.formatToParts(new Date()).forEach(function (p) { parts[p.type] = p.value; });
  var dateStr = parts.year + parts.month + parts.day; // YYYYMMDD
  var hh = parts.hour, mm = parts.minute;
  return { dateStr: dateStr, hh: hh, mm: mm, hhmm: hh + ":" + mm };
}

// ── State ──────────────────────────────────────────────────────
var adminPwd = "";
var allSlots = [];                // /slots response (admin-enriched)
var currentBookings = [];         // bookings for selected slot
var inFlight = new Set();         // bookingIds with pending /checkin
var pollHandle = null;
var selectedDate = "";            // YYYYMMDD
var selectedTime = "";            // HH:mm
var showRemoved = false;
var searchTerm = "";

// ── Login screen render ────────────────────────────────────────
var mainEl = document.getElementById("main");
var logoutBtn = document.getElementById("logoutBtn");

function renderLogin(opts) {
  mainEl.innerHTML =
    '<div class="login-screen">' +
      '<div class="login-card">' +
        '<h2>Logga in</h2>' +
        '<p>Ange admin-lösenord för att börja checka in gäster.</p>' +
        '<label for="pwdInput">Lösenord</label>' +
        '<input id="pwdInput" type="password" autocomplete="current-password" inputmode="text" autofocus />' +
        '<div class="actions">' +
          '<button class="btn-primary" id="loginBtn" type="button">Logga in</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  logoutBtn.hidden = true;
  var pwdInput = document.getElementById("pwdInput");
  var loginBtn = document.getElementById("loginBtn");
  pwdInput.focus();
  loginBtn.addEventListener("click", attemptLogin);
  pwdInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter") attemptLogin();
  });
  if (opts && opts.message) showError(opts.message);
}

function attemptLogin() {
  var pwdInput = document.getElementById("pwdInput");
  var loginBtn = document.getElementById("loginBtn");
  var pwd = pwdInput.value.trim();
  if (!pwd) return;
  loginBtn.disabled = true;
  loginBtn.textContent = "Loggar in…";
  validateAndStart(pwd).catch(function (err) {
    loginBtn.disabled = false;
    loginBtn.textContent = "Logga in";
    if (err.status === 400 || err.status === 401 || err.status === 403) {
      try { localStorage.removeItem(PWD_KEY); } catch (e) {}
      showError("Fel lösenord");
    } else {
      showError("Inloggning misslyckades: " + err.message);
    }
  });
}

function validateAndStart(pwd) {
  // Use admin-only endpoint to truly verify the password.
  // /slot-configs is admin-only per swagger v3.0.0; anon callers get HTTP 400.
  return fetchJson(API_BASE + "/slot-configs?admin=" + encodeURIComponent(pwd))
    .then(function () {
      adminPwd = pwd;
      try { localStorage.setItem(PWD_KEY, pwd); } catch (e) {}
      return loadInitialAndRender();
    });
}

// ── Slot list, default selection ───────────────────────────────
function loadInitialAndRender() {
  return fetchJson(API_BASE + "/slots?admin=" + encodeURIComponent(adminPwd))
    .then(function (data) {
      allSlots = Array.isArray(data) ? data : [];
      chooseDefaultSlot();
      renderMain();
      startPoll();
      return refreshBookings();
    });
}

function chooseDefaultSlot() {
  var now = nowInStockholm();
  // All open slots grouped by date
  var byDate = {};
  allSlots.forEach(function (s) {
    if (s.isOpen !== true) return;
    if (!byDate[s.dateStr]) byDate[s.dateStr] = [];
    byDate[s.dateStr].push(s);
  });

  var todayOpen = byDate[now.dateStr] || [];
  if (todayOpen.length) {
    // first slot whose endTime >= now, else last slot of today
    var pick = todayOpen.find(function (s) { return s.endTime >= now.hhmm; });
    if (!pick) pick = todayOpen[todayOpen.length - 1];
    selectedDate = pick.dateStr;
    selectedTime = pick.startTime;
    return;
  }

  // No open slot today — pick first future date with open slot
  var futureDates = Object.keys(byDate)
    .filter(function (d) { return d >= now.dateStr; })
    .sort();
  if (futureDates.length) {
    var firstFutureDate = futureDates[0];
    selectedDate = firstFutureDate;
    selectedTime = byDate[firstFutureDate][0].startTime;
    return;
  }

  // No future open slots at all — default to today, first slot regardless of openness
  selectedDate = now.dateStr;
  var anyToday = allSlots.filter(function (s) { return s.dateStr === now.dateStr; });
  selectedTime = anyToday.length ? anyToday[0].startTime : "";
}

function distinctDates() {
  var seen = {};
  allSlots.forEach(function (s) { seen[s.dateStr] = true; });
  var today = nowInStockholm().dateStr;
  seen[today] = true; // always show today
  return Object.keys(seen).sort();
}

function timesForDate(dateStr) {
  return allSlots
    .filter(function (s) { return s.dateStr === dateStr; })
    .map(function (s) { return s.startTime; })
    .sort();
}

function formatDateLabel(dateStr) {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  var y = +dateStr.slice(0, 4), m = +dateStr.slice(4, 6), d = +dateStr.slice(6, 8);
  var dt = new Date(Date.UTC(y, m - 1, d));
  var fmt = new Intl.DateTimeFormat("sv-SE", {
    weekday: "short", day: "numeric", month: "short",
    timeZone: "UTC",
  });
  return dateStr + " · " + fmt.format(dt);
}

// ── Main UI ────────────────────────────────────────────────────
function renderMain() {
  var dates = distinctDates();
  var times = timesForDate(selectedDate);

  var dateOptions = dates.map(function (d) {
    return '<option value="' + d + '"' + (d === selectedDate ? " selected" : "") + ">" + escapeHtml(formatDateLabel(d)) + "</option>";
  }).join("");

  var timeOptions = times.length
    ? times.map(function (t) {
        return '<option value="' + t + '"' + (t === selectedTime ? " selected" : "") + ">" + escapeHtml(t) + "</option>";
      }).join("")
    : '<option value="" disabled selected>Inga öppna pass</option>';

  mainEl.innerHTML =
    '<div class="toolbar">' +
      '<select id="dateSel" aria-label="Välj datum">' + dateOptions + '</select>' +
      '<select id="timeSel" aria-label="Välj tid"' + (times.length ? "" : " disabled") + '>' + timeOptions + '</select>' +
      '<label class="stats-toggle"><input type="checkbox" id="showRemoved"' + (showRemoved ? " checked" : "") + ' /> Visa borttagna</label>' +
      '<button class="btn-reload" id="reloadBtn" type="button" aria-label="Ladda om" title="Ladda om">↻</button>' +
    '</div>' +
    '<div class="stats" id="stats"></div>' +
    '<input type="search" class="search" id="searchInput" placeholder="Sök på namn eller boknings-ID" inputmode="search" enterkeyhint="search" autofocus value="' + escapeAttr(searchTerm) + '" />' +
    '<div class="bookings-list" id="bookingsList"><div class="empty">Laddar bokningar…</div></div>';

  logoutBtn.hidden = false;
  logoutBtn.onclick = logout;
  document.getElementById("dateSel").addEventListener("change", function () {
    selectedDate = this.value;
    var firstTime = timesForDate(selectedDate)[0] || "";
    selectedTime = firstTime;
    searchTerm = "";
    renderMain();
    cancelPoll();
    startPoll();
    refreshBookings();
  });
  document.getElementById("timeSel").addEventListener("change", function () {
    selectedTime = this.value;
    searchTerm = "";
    cancelPoll();
    startPoll();
    refreshBookings();
    renderBookingList();
  });
  document.getElementById("showRemoved").addEventListener("change", function () {
    showRemoved = this.checked;
    renderBookingList();
  });
  document.getElementById("reloadBtn").addEventListener("click", function () {
    var btn = this;
    btn.classList.add("loading");
    refreshBookings().finally(function () { btn.classList.remove("loading"); });
  });
  var search = document.getElementById("searchInput");
  search.addEventListener("input", function () {
    searchTerm = this.value;
    renderBookingList();
  });
  search.addEventListener("keydown", function (e) {
    if (e.key === "Escape") { this.value = ""; searchTerm = ""; renderBookingList(); }
  });

  renderStats();
  renderBookingList();
}

function renderStats() {
  var statsEl = document.getElementById("stats");
  if (!statsEl) return;
  var newCount = currentBookings.filter(function (b) { return effectiveStatus(b) === "NEW"; }).length;
  var checkedinCount = currentBookings.filter(function (b) { return effectiveStatus(b) === "CHECKED_IN"; }).length;
  var total = newCount + checkedinCount;
  statsEl.innerHTML =
    '<span>Incheckade:</span>' +
    '<span class="big">' + checkedinCount + ' / ' + total + '</span>' +
    '<span class="stats-spacer"></span>';
}

function effectiveStatus(b) {
  // In-flight check-in keeps optimistic CHECKED_IN regardless of stale server data
  if (inFlight.has(b.bookingId) && b.__optimistic === "CHECKED_IN") return "CHECKED_IN";
  return b.status || "NEW";
}

function renderBookingList() {
  var listEl = document.getElementById("bookingsList");
  if (!listEl) return;

  var term = (searchTerm || "").toLowerCase().trim();
  var rows = currentBookings
    .filter(function (b) {
      var status = effectiveStatus(b);
      if (status === "REMOVED" && !showRemoved) return false;
      if (!term) return true;
      var name = (b.name || "").toLowerCase();
      var id = (b.bookingId || "").toLowerCase();
      return name.indexOf(term) !== -1 || id.indexOf(term) !== -1;
    })
    .sort(function (a, b) {
      var rank = { NEW: 0, CHECKED_IN: 1, REMOVED: 2 };
      var sa = effectiveStatus(a), sb = effectiveStatus(b);
      if (rank[sa] !== rank[sb]) return rank[sa] - rank[sb];
      return (a.name || "").localeCompare(b.name || "", "sv");
    });

  if (rows.length === 0) {
    listEl.innerHTML = '<div class="empty">' + (term ? "Inga träffar." : "Inga bokningar i detta pass.") + '</div>';
    renderStats();
    return;
  }

  listEl.innerHTML = rows.map(function (b) {
    var status = effectiveStatus(b);
    var classes = ["booking-card"];
    if (status === "CHECKED_IN") classes.push("is-checkedin");
    if (status === "REMOVED") classes.push("is-removed");
    if (inFlight.has(b.bookingId)) classes.push("in-flight");
    if (STAGE === "dev" && status === "NEW") classes.push("dev-outline");

    var pillCls = status === "CHECKED_IN" ? "pill-checkedin" : status === "REMOVED" ? "pill-removed" : "pill-new";
    var pillText = status === "CHECKED_IN" ? "✓ Incheckad" : status === "REMOVED" ? "Borttagen" : "Bokad";

    var adults = b.numberOfAdults || 0;
    var kids = b.numberOfKids || 0;
    var pens = b.numberOfPensioners || 0;
    var cars = b.numberOfCars || 0;

    var chipsHtml =
      '<span class="chip chip-kids"><strong>' + kids + '</strong> barn</span>' +
      '<span class="chip chip-adults"><strong>' + adults + '</strong> vuxna</span>' +
      '<span class="chip chip-pens"><strong>' + pens + '</strong> pens</span>' +
      (cars > 0 ? '<span class="chip chip-cars"><strong>' + cars + '</strong> ' + (cars === 1 ? 'bil' : 'bilar') + '</span>' : '');

    var actionHtml;
    if (status === "NEW") {
      var loadingCls = inFlight.has(b.bookingId) ? " loading" : "";
      actionHtml =
        '<button class="btn-checkin' + loadingCls + '" type="button" data-id="' + escapeAttr(b.bookingId) + '"' +
        (inFlight.has(b.bookingId) ? " disabled" : "") + '>Checka in</button>';
    } else {
      actionHtml = '<span class="pill ' + pillCls + '">' + pillText + '</span>';
    }

    return (
      '<div class="' + classes.join(" ") + '">' +
        '<span class="b-id">' + escapeHtml(b.bookingId) + '</span>' +
        '<div class="b-name">' + escapeHtml(b.name || "(utan namn)") + '</div>' +
        '<div class="b-chips">' + chipsHtml + '</div>' +
        '<div class="b-action">' + actionHtml + '</div>' +
      '</div>'
    );
  }).join("");

  // Wire check-in buttons
  listEl.querySelectorAll(".btn-checkin").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var id = this.getAttribute("data-id");
      var booking = currentBookings.find(function (b) { return b.bookingId === id; });
      if (booking) checkIn(booking);
    });
  });

  renderStats();
}

// ── Bookings fetch + poll ──────────────────────────────────────
function buildBookingsUrl() {
  var params = new URLSearchParams();
  params.set("d", selectedDate);
  params.set("t", selectedTime);
  params.set("admin", adminPwd);
  return API_BASE + "/bookings?" + params.toString();
}

function refreshBookings() {
  if (!selectedDate || !selectedTime) {
    currentBookings = [];
    renderBookingList();
    return Promise.resolve();
  }
  return fetchJson(buildBookingsUrl())
    .then(function (data) {
      var fresh = Array.isArray(data) ? data : [];
      // Merge: any in-flight bookingId keeps its local optimistic status
      var byId = {};
      fresh.forEach(function (b) { byId[b.bookingId] = b; });
      currentBookings = fresh.map(function (b) {
        if (inFlight.has(b.bookingId)) {
          return Object.assign({}, b, { __optimistic: "CHECKED_IN" });
        }
        return b;
      });
      // Also keep optimistic-only entries that may not yet be in the response
      inFlight.forEach(function (id) {
        if (!byId[id]) {
          var existing = currentBookings.find(function (x) { return x.bookingId === id; });
          if (!existing) {
            // Best-effort: keep the previous booking with optimistic status
          }
        }
      });
      renderBookingList();
    })
    .catch(function (err) {
      showError("Kunde inte hämta bokningar: " + err.message);
    });
}

function startPoll() {
  cancelPoll();
  pollHandle = setInterval(function () {
    if (document.hidden) return;
    refreshBookings();
  }, 60000);
}
function cancelPoll() {
  if (pollHandle) { clearInterval(pollHandle); pollHandle = null; }
}

document.addEventListener("visibilitychange", function () {
  if (document.hidden) return;
  if (adminPwd) {
    refreshBookings();
    startPoll();
  }
});

// ── Check-in (optimistic + idempotent reconciliation) ──────────
function checkIn(booking) {
  if (inFlight.has(booking.bookingId)) return;
  inFlight.add(booking.bookingId);
  booking.__optimistic = "CHECKED_IN";
  var prevStatus = booking.status;
  booking.status = "CHECKED_IN";
  renderBookingList();

  var url = API_BASE + "/bookings/" + encodeURIComponent(booking.bookingId) +
    "/checkin?admin=" + encodeURIComponent(adminPwd);

  fetchJson(url)
    .then(function () {
      inFlight.delete(booking.bookingId);
      delete booking.__optimistic;
      showSuccess("Incheckad: " + booking.name);
      renderBookingList();
    })
    .catch(function (err) {
      // Refetch to learn ground truth — /checkin is idempotent
      refreshBookings()
        .then(function () {
          var refreshed = currentBookings.find(function (b) { return b.bookingId === booking.bookingId; });
          inFlight.delete(booking.bookingId);
          if (refreshed && refreshed.status === "CHECKED_IN") {
            showSuccess("Status verifierad: " + refreshed.name);
          } else {
            if (refreshed) refreshed.status = prevStatus;
            showError("Incheckning misslyckades: " + err.message);
          }
          renderBookingList();
        })
        .catch(function () {
          // Both /checkin and refetch failed — fail loud and safe
          inFlight.delete(booking.bookingId);
          booking.status = prevStatus;
          delete booking.__optimistic;
          renderBookingList();
          showError("Kunde inte verifiera incheckning. Tryck Ladda om och försök igen.", { sticky: true });
        });
    });
}

// ── Logout ─────────────────────────────────────────────────────
function logout() {
  cancelPoll();
  inFlight.clear();
  currentBookings = [];
  allSlots = [];
  adminPwd = "";
  try { localStorage.removeItem(PWD_KEY); } catch (e) {}
  renderLogin();
}

// ── Boot ───────────────────────────────────────────────────────
(function boot() {
  var saved = "";
  try { saved = localStorage.getItem(PWD_KEY) || ""; } catch (e) {}
  if (!saved) {
    renderLogin();
    return;
  }
  adminPwd = saved;
  mainEl.innerHTML = '<div class="empty">Loggar in…</div>';
  logoutBtn.hidden = false;
  logoutBtn.onclick = logout;
  validateAndStart(saved).catch(function (err) {
    adminPwd = "";
    try { localStorage.removeItem(PWD_KEY); } catch (e) {}
    renderLogin({ message: err.status === 400 || err.status === 401 || err.status === 403
      ? "Sparat lösenord ogiltigt — logga in igen."
      : "Auto-login misslyckades: " + err.message });
  });
})();
