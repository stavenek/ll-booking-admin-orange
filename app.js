(function logFetches() {
  var orig = window.fetch;
  window.fetch = function (input, init) {
    var url = typeof input === "string" ? input : (input && input.url) || String(input);
    var method = (init && init.method) || (typeof input !== "string" && input && input.method) || "GET";
    var safe = url.replace(/admin=[^&]*/g, "admin=***");
    console.log("[fetch]", method, safe);
    return orig.apply(this, arguments);
  };
})();

const STAGES = {
  dev: "https://95gewohkpj.execute-api.eu-north-1.amazonaws.com/dev/llb/v1",
  prod: "https://eay07x2tc7.execute-api.eu-north-1.amazonaws.com/prod/llb/v1",
};

// Wrapper that surfaces backend error details. Throws an Error whose
// .message is the API's errorMsg when present (HTTP error or success:false),
// otherwise "HTTP <status>" or the underlying network message.
function fetchJson(url, init) {
  return fetch(url, init).then(function (res) {
    return res.text().then(function (text) {
      var body = null;
      if (text) { try { body = JSON.parse(text); } catch (e) {} }
      if (!res.ok) {
        var msg = (body && (body.errorMsg || body.message)) ||
          (text && text.length < 200 ? text : "") ||
          ("HTTP " + res.status);
        var err = new Error(msg);
        err.status = res.status;
        err.body = body;
        console.error("[fetch error]", res.status, url.replace(/admin=[^&]*/g, "admin=***"), body || text);
        throw err;
      }
      if (body && body.success === false) {
        var err2 = new Error(body.errorMsg || body.errorCode || "Request failed");
        err2.body = body;
        console.error("[api success:false]", url.replace(/admin=[^&]*/g, "admin=***"), body);
        throw err2;
      }
      return body;
    });
  });
}
const STAGE_STORAGE_KEY = "llStage";
const PWD_STORAGE_KEY = "llAdminPwd";
const STATUS_FILTER_STORAGE_KEY = "llStatusFilter";
const SORT_STORAGE_KEY = "llBookingSort";

function resolveStage() {
  var params = new URLSearchParams(window.location.search);
  var fromUrl = params.get("stage");
  if (fromUrl && STAGES[fromUrl]) {
    try { localStorage.setItem(STAGE_STORAGE_KEY, fromUrl); } catch (e) {}
    return fromUrl;
  }
  try {
    var stored = localStorage.getItem(STAGE_STORAGE_KEY);
    if (stored && STAGES[stored]) return stored;
  } catch (e) {}
  // Default to dev until ll-booking-backend dev→main merge & prod deploy
  // ships body.status, numberOfAdults rename, and the partial-PUT merge fix.
  return "dev";
}

const STAGE = resolveStage();
const API_BASE = STAGES[STAGE];
let adminPwd = "";
let allBookings = [];
let filteredBookings = [];
let currentPage = 1;
const PAGE_SIZE = 10;
let availableDates = [];
let slotStatusesByDate = {};
let allTemplates = [];
let allPlaceholders = [];
let editingTemplateId = null;
let slotConfigByDate = {};
let selectedDateStr = null;
let calYear = 0;
let calMonth = 0; // 0-indexed
const DEFAULT_CAPACITY = 50;

const VINTROSA_LAT = 59.2667;
const VINTROSA_LON = 14.9333;
let weatherByHour = {}; // key: "YYYY-MM-DD HH:00" Europe/Stockholm, value: { temp, symbol }

const WEATHER_EMOJI = {
  1: "☀️", 2: "🌤️", 3: "⛅", 4: "⛅", 5: "☁️", 6: "☁️", 7: "🌫️",
  8: "🌦️", 9: "🌦️", 10: "🌦️", 11: "⛈️",
  12: "🌨️", 13: "🌨️", 14: "🌨️", 15: "🌨️", 16: "🌨️", 17: "🌨️",
  18: "🌧️", 19: "🌧️", 20: "🌧️", 21: "⛈️",
  22: "🌨️", 23: "🌨️", 24: "🌨️", 25: "❄️", 26: "❄️", 27: "❄️",
};

function isoUtcToLocalHourKey(iso) {
  var parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(iso)).reduce(function (acc, p) {
    acc[p.type] = p.value;
    return acc;
  }, {});
  return parts.year + "-" + parts.month + "-" + parts.day + " " + parts.hour + ":00";
}

function fetchWeather() {
  var url = "https://opendata-download-metfcst.smhi.se/api/category/snow1g/version/1" +
    "/geotype/point/lon/" + VINTROSA_LON + "/lat/" + VINTROSA_LAT + "/data.json";
  return fetch(url)
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data || !Array.isArray(data.timeSeries)) return;
      var timestamps = [];
      data.timeSeries.forEach(function (entry) {
        if (!entry || !entry.data) return;
        var key = isoUtcToLocalHourKey(entry.time);
        weatherByHour[key] = {
          temp: Math.round(entry.data.air_temperature),
          symbol: entry.data.symbol_code,
        };
        timestamps.push(new Date(entry.time).getTime());
      });
      // SMHI:s upplösning glesnar (1h → 3h → 6h). Forward-fill varje timme
      // mellan första och sista entry så slot-lookups träffar närmaste tidigare värde.
      if (timestamps.length < 2) return;
      timestamps.sort(function (a, b) { return a - b; });
      var prev = null;
      for (var ms = timestamps[0]; ms <= timestamps[timestamps.length - 1]; ms += 3600000) {
        var k = isoUtcToLocalHourKey(new Date(ms).toISOString());
        if (weatherByHour[k]) prev = weatherByHour[k];
        else if (prev) weatherByHour[k] = prev;
      }
    })
    .catch(function () { /* tyst — Daily Overview renderas utan väder */ });
}

// Presets derived from ll-booking-backend/lambda/util/legacySlotConfigs.ts
const SLOT_PRESETS = [
  {
    id: "season-hi",
    label: "High season — 5 slots, 10–17",
    slots: [
      { startTime: "10:00", endTime: "13:00", maxPeopleForSlot: 110 },
      { startTime: "11:00", endTime: "14:00", maxPeopleForSlot: 110 },
      { startTime: "12:00", endTime: "15:00", maxPeopleForSlot: 110 },
      { startTime: "13:00", endTime: "16:00", maxPeopleForSlot: 110 },
      { startTime: "14:00", endTime: "17:00", maxPeopleForSlot: 40 },
    ],
  },
  {
    id: "season-low",
    label: "Low season — 4 slots, 10–16",
    slots: [
      { startTime: "10:00", endTime: "13:00", maxPeopleForSlot: 110 },
      { startTime: "11:00", endTime: "14:00", maxPeopleForSlot: 110 },
      { startTime: "12:00", endTime: "15:00", maxPeopleForSlot: 110 },
      { startTime: "13:00", endTime: "16:00", maxPeopleForSlot: 110 },
    ],
  },
  {
    id: "season-low-test",
    label: "Low season TEST — 3 slots, 10–15, max 5",
    slots: [
      { startTime: "10:00", endTime: "13:00", maxPeopleForSlot: 5 },
      { startTime: "11:00", endTime: "14:00", maxPeopleForSlot: 5 },
      { startTime: "12:00", endTime: "15:00", maxPeopleForSlot: 5 },
    ],
  },
  {
    id: "afternoon",
    label: "Afternoon — 2 slots, 12–16",
    slots: [
      { startTime: "12:00", endTime: "15:00", maxPeopleForSlot: 110 },
      { startTime: "13:00", endTime: "16:00", maxPeopleForSlot: 110 },
    ],
  },
  {
    id: "halloween",
    label: "Halloween — 3 slots, 11–16",
    slots: [
      { startTime: "11:00", endTime: "14:00", maxPeopleForSlot: 110 },
      { startTime: "12:00", endTime: "15:00", maxPeopleForSlot: 110 },
      { startTime: "13:00", endTime: "16:00", maxPeopleForSlot: 110 },
    ],
  },
  {
    id: "hourly",
    label: "Hourly — 7 slots, 10–17, max 50",
    slots: [
      { startTime: "10:00", endTime: "11:00", maxPeopleForSlot: 50 },
      { startTime: "11:00", endTime: "12:00", maxPeopleForSlot: 50 },
      { startTime: "12:00", endTime: "13:00", maxPeopleForSlot: 50 },
      { startTime: "13:00", endTime: "14:00", maxPeopleForSlot: 50 },
      { startTime: "14:00", endTime: "15:00", maxPeopleForSlot: 50 },
      { startTime: "15:00", endTime: "16:00", maxPeopleForSlot: 50 },
      { startTime: "16:00", endTime: "17:00", maxPeopleForSlot: 50 },
    ],
  },
];

const DEFAULT_PRESET_ID = "season-low";

// ── DOM References ────────────────────────────────────────────────
const pwdInput = document.getElementById("pwd");
const setPwdBtn = document.getElementById("setPwdBtn");
const navTabs = document.getElementById("navTabs");
const filterContainer = document.getElementById("filterContainer");
const filterInput = document.getElementById("filterInput");
const errorDiv = document.getElementById("error");
const tableContainer = document.getElementById("tableContainer");
const paginationDiv = document.getElementById("pagination");
const totalBookingsSpan = document.getElementById("totalBookings");
const filteredBookingsSpan = document.getElementById("filteredBookings");
const statTotalBox = document.getElementById("statTotal");
const statFilteredBox = document.getElementById("statFiltered");
const bookingsPanel = document.getElementById("bookingsPanel");
const templatesPanel = document.getElementById("templatesPanel");
const slotsPanel = document.getElementById("slotsPanel");
const dailyPanel = document.getElementById("dailyPanel");
const dailyOverviewEl = document.getElementById("dailyOverview");
const dailyError = document.getElementById("dailyError");
const slotsError = document.getElementById("slotsError");
const calTitle = document.getElementById("calTitle");
const calendarGrid = document.getElementById("calendarGrid");
const calPrevBtn = document.getElementById("calPrevBtn");
const calNextBtn = document.getElementById("calNextBtn");
const dayDetail = document.getElementById("dayDetail");
const emailError = document.getElementById("emailError");
const templatesList = document.getElementById("templatesList");
const updateModal = document.getElementById("updateModal");
const editorModal = document.getElementById("editorModal");
const editorTitle = document.getElementById("editorTitle");
const editorError = document.getElementById("editorError");
const editorCloseBtn = document.getElementById("editorCloseBtn");
const tplTypeSelect = document.getElementById("tplType");
const editorSidebar = document.getElementById("editorSidebar");
const placeholderListEl = document.getElementById("placeholderList");
const tplNameInput = document.getElementById("tplName");
const tplSubjectInput = document.getElementById("tplSubject");
const tplBodyInput = document.getElementById("tplBody");
const tplActiveInput = document.getElementById("tplActive");
const saveTemplateBtn = document.getElementById("saveTemplateBtn");
const cancelTemplateBtn = document.getElementById("cancelTemplateBtn");

// ── Build stamp ───────────────────────────────────────────────────
(function renderBuildStamp() {
  var el = document.getElementById("buildStamp");
  if (!el) return;
  var raw = window.LL_BUILD_TIME;
  if (!raw) {
    el.textContent = "dev";
    return;
  }
  var dt = new Date(raw);
  if (isNaN(dt.getTime())) {
    el.textContent = "build " + raw;
    return;
  }
  el.textContent = "build " + dt.toLocaleString("sv-SE", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  el.title = "Build " + raw;
})();


// ── Navigation tabs ───────────────────────────────────────────────
var templatesFetched = false;
var slotConfigsFetched = false;

function switchTab(tabName) {
  document.querySelectorAll(".nav-tab").forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabName);
  });
  bookingsPanel.classList.toggle("visible", tabName === "bookings");
  templatesPanel.classList.toggle("visible", tabName === "templates");
  slotsPanel.classList.toggle("visible", tabName === "slots");
  dailyPanel.classList.toggle("visible", tabName === "daily");
  if (tabName === "slots" && adminPwd) {
    if (!slotConfigsFetched) {
      slotConfigsFetched = true;
      fetchSlotConfigs().catch(function () { slotConfigsFetched = false; });
    }
    refreshSlotCounts();
  }
  if (tabName === "templates" && adminPwd && !templatesFetched) {
    templatesFetched = true;
    fetchEmailTemplates().catch(function () { templatesFetched = false; });
  }
  if (tabName === "daily") {
    renderDailyOverview();
  }
}

function refreshSlotCounts() {
  return fetchAvailableDates()
    .then(function () {
      renderCalendar();
      if (selectedDateStr) renderDayDetail();
    })
    .catch(function () {});
}

navTabs.addEventListener("click", function (evt) {
  var tab = evt.target.closest(".nav-tab");
  if (!tab) return;
  switchTab(tab.getAttribute("data-tab"));
});

// ── Load bookings ─────────────────────────────────────────────────
setPwdBtn.addEventListener("click", function () {
  adminPwd = pwdInput.value.trim();
  if (!adminPwd) {
    alert("Please enter the admin password.");
    return;
  }
  filterInput.value = "";
  setPwdBtn.disabled = true;
  setPwdBtn.textContent = "";
  setPwdBtn.classList.add("loading");
  // Show the chrome immediately so the page feels responsive while data loads.
  filterContainer.classList.add("visible");
  navTabs.classList.add("visible");
  document.getElementById("statsCounter").classList.add("visible");
  bookingsPanel.classList.add("visible");
  fetchBookings()
    .finally(function () {
      setPwdBtn.disabled = false;
      setPwdBtn.textContent = "Login";
      setPwdBtn.classList.remove("loading");
    });
});

pwdInput.addEventListener("keydown", function (evt) {
  if (evt.key === "Enter") {
    setPwdBtn.click();
  }
});

function fetchBookings() {
  tableContainer.innerHTML = '<div class="empty-state">Loading...</div>';
  paginationDiv.innerHTML = "";

  var bookingsReq = fetchJson(API_BASE + "/bookings?admin=" + encodeURIComponent(adminPwd));
  var slotsReq = fetchAvailableDates();

  return Promise.all([bookingsReq, slotsReq, fetchWeather()])
    .catch(function (err) {
      if (err.status === 400 || err.status === 401 || err.status === 403) {
        try { localStorage.removeItem(PWD_STORAGE_KEY); } catch (e) {}
        throw new Error("Wrong password — please log in again.");
      }
      throw err;
    })
    .then(function (results) {
      var data = results[0];
      allBookings = Array.isArray(data) ? data : [];
      filterBookings(filterInput.value.toLowerCase());
      filterContainer.classList.add("visible");
      navTabs.classList.add("visible");
      document.getElementById("statsCounter").classList.add("visible");
      currentPage = 1;
      renderTable();
      renderPagination();
      updateBookingStats();
      renderDailyOverview();
      try { localStorage.setItem(PWD_STORAGE_KEY, adminPwd); } catch (e) {}
    })
    .catch(function (err) {
      tableContainer.innerHTML = "";
      showError(err.message);
    });
}

function fetchAvailableDates() {
  return fetchJson(API_BASE + "/slots?admin=" + encodeURIComponent(adminPwd))
    .then(function (data) {
      slotStatusesByDate = {};
      var dateSet = new Set();
      data.forEach(function (slot) {
        if (slot.isOpen && slot.isAvailable) {
          dateSet.add(slot.dateStr);
        }
        if (!slotStatusesByDate[slot.dateStr]) slotStatusesByDate[slot.dateStr] = {};
        slotStatusesByDate[slot.dateStr][slot.startTime] = slot;
      });
      availableDates = Array.from(dateSet).sort();
    });
}

// ── Filter ────────────────────────────────────────────────────────
function wireReloadButton(id, action) {
  var btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener("click", function () {
    if (!adminPwd) return;
    btn.disabled = true;
    btn.classList.add("loading");
    Promise.resolve(action()).finally(function () {
      btn.disabled = false;
      btn.classList.remove("loading");
    });
  });
}

wireReloadButton("reloadBookingsBtn", fetchBookings);
wireReloadButton("reloadDailyBtn", fetchBookings);
wireReloadButton("reloadTemplatesBtn", fetchEmailTemplates);
wireReloadButton("reloadSlotsBtn", function () {
  return Promise.all([fetchSlotConfigs(), fetchAvailableDates()])
    .then(function () { renderCalendar(); if (selectedDateStr) renderDayDetail(); });
});

filterInput.addEventListener("input", function (evt) {
  var term = evt.target.value.toLowerCase();
  filterBookings(term);
  currentPage = 1;
  renderTable();
  renderPagination();
});

// ── Status filter ─────────────────────────────────────────────────
const VALID_STATUS_FILTERS = ["NEW", "CHECKED_IN", "REMOVED"];
var statusFilter = loadStatusFilter();

function loadStatusFilter() {
  try {
    var raw = localStorage.getItem(STATUS_FILTER_STORAGE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        var valid = parsed.filter(function (s) { return VALID_STATUS_FILTERS.indexOf(s) !== -1; });
        if (valid.length > 0) return valid;
      }
    }
  } catch (e) {}
  return ["NEW"];
}

function persistStatusFilter() {
  try { localStorage.setItem(STATUS_FILTER_STORAGE_KEY, JSON.stringify(statusFilter)); } catch (e) {}
}

function syncStatusFilterCheckboxes() {
  document.querySelectorAll(".status-filter-cb").forEach(function (cb) {
    cb.checked = statusFilter.indexOf(cb.getAttribute("data-status")) !== -1;
  });
}

document.querySelectorAll(".status-filter-cb").forEach(function (cb) {
  cb.addEventListener("change", function () {
    var status = this.getAttribute("data-status");
    var idx = statusFilter.indexOf(status);
    if (this.checked && idx === -1) statusFilter.push(status);
    if (!this.checked && idx !== -1) statusFilter.splice(idx, 1);
    persistStatusFilter();
    var term = filterInput.value.toLowerCase();
    filterBookings(term);
    currentPage = 1;
    renderTable();
    renderPagination();
  });
});

syncStatusFilterCheckboxes();

function filterBookings(term) {
  var today = todayDateStr();
  filteredBookings = allBookings.filter(function (b) {
    if (b.dateStr && normalizeDateStr(b.dateStr) < normalizeDateStr(today)) return false;
    var status = (typeof b.status === "string" && VALID_STATUS_FILTERS.indexOf(b.status) !== -1) ? b.status : "NEW";
    if (statusFilter.indexOf(status) === -1) return false;
    if (!term) return true;
    return Object.values(b).some(function (v) {
      return String(v).toLowerCase().includes(term);
    });
  });
  updateBookingStats();
}

// ── Stats ─────────────────────────────────────────────────────────
function updateBookingStats() {
  totalBookingsSpan.textContent = allBookings.length;
  filteredBookingsSpan.textContent = filteredBookings.length;

  var hint = document.getElementById("filterHint");
  if (!hint) return;
  var hidden = allBookings.length - filteredBookings.length;
  if (hidden <= 0) {
    hint.hidden = true;
    hint.textContent = "";
    return;
  }
  var hiddenByStatus = 0;
  allBookings.forEach(function (b) {
    var s = (typeof b.status === "string" && VALID_STATUS_FILTERS.indexOf(b.status) !== -1) ? b.status : "NEW";
    if (statusFilter.indexOf(s) === -1) hiddenByStatus += 1;
  });
  var parts = [hidden + " booking" + (hidden === 1 ? "" : "s") + " hidden"];
  if (hiddenByStatus > 0 && statusFilter.length < VALID_STATUS_FILTERS.length) {
    var unchecked = VALID_STATUS_FILTERS
      .filter(function (s) { return statusFilter.indexOf(s) === -1; })
      .map(function (s) { return s === "NEW" ? "Aktiva" : s === "CHECKED_IN" ? "Incheckade" : "Raderade"; });
    parts.push("check " + unchecked.join(" / ") + " to include");
  } else if (filterInput.value) {
    parts.push("clear search to include");
  }
  hint.textContent = parts.join(" — ");
  hint.hidden = false;
}

// ── Daily overview ────────────────────────────────────────────────
function todayDateStr() {
  var t = new Date();
  var m = String(t.getMonth() + 1).padStart(2, "0");
  var d = String(t.getDate()).padStart(2, "0");
  return t.getFullYear() + "-" + m + "-" + d;
}

// Accepts "YYYY-MM-DD" or "YYYYMMDD"; returns "YYYYMMDD" for safe lex compare.
function normalizeDateStr(s) {
  if (!s) return "";
  return String(s).replace(/-/g, "");
}

function formatWeekday(dateStr) {
  var n = normalizeDateStr(dateStr);
  if (n.length !== 8) return "";
  var iso = n.slice(0, 4) + "-" + n.slice(4, 6) + "-" + n.slice(6, 8);
  var dt = new Date(iso + "T00:00:00");
  if (isNaN(dt.getTime())) return "";
  var sv = ["Sö", "Må", "Ti", "Ons", "To", "Fr", "Lö"];
  return sv[dt.getDay()];
}

// Entrance fees (Kr per person) used to estimate daily income on the Daily Overview.
// barn 2–15 år / vuxen / pensionär
const ENTRANCE_FEES = { kids: 140, adults: 60, pensioners: 30 };
// Multiplier applied to the raw entrance-fee sum for the income estimate.
const INCOME_MULTIPLIER = 1.27;
// Estimated hamburgers ≈ slope × besökare (visitors) + intercept.
const HAMBURGER_FIT = { slope: 0.1125, intercept: -3.81 };

function renderDailyOverview() {
  if (!dailyOverviewEl) return;
  if (allBookings.length === 0 && availableDates.length === 0) {
    dailyOverviewEl.innerHTML = '<div class="empty-state">No upcoming bookings.</div>';
    return;
  }

  var today = todayDateStr();
  var byDate = {};

  function toCount(v) {
    if (v == null) return 0;
    var n = Number(v);
    return isNaN(n) ? 0 : n;
  }

  function ensureDay(ds) {
    if (!byDate[ds]) byDate[ds] = { newCount: 0, checkedCount: 0, adults: 0, kids: 0, pens: 0, slots: {} };
    return byDate[ds];
  }

  allBookings.forEach(function (b) {
    var status = (typeof b.status === "string" && VALID_STATUS_FILTERS.indexOf(b.status) !== -1) ? b.status : "NEW";
    if (status === "REMOVED") return;
    if (!b.dateStr || normalizeDateStr(b.dateStr) < normalizeDateStr(today)) return;
    var d = ensureDay(b.dateStr);
    if (status === "CHECKED_IN") d.checkedCount += 1;
    else d.newCount += 1;
    var adults = toCount(b.numberOfAdults != null ? b.numberOfAdults : b.numberOfPeople);
    var kids = toCount(b.numberOfKids);
    var pens = toCount(b.numberOfPensioners);
    d.adults += adults;
    d.kids += kids;
    d.pens += pens;
    var t = b.timeStr || "";
    if (!d.slots[t]) d.slots[t] = { newCount: 0, checkedCount: 0 };
    if (status === "CHECKED_IN") d.slots[t].checkedCount += 1;
    else d.slots[t].newCount += 1;
  });

  availableDates.forEach(function (ds) {
    if (normalizeDateStr(ds) < normalizeDateStr(today)) return;
    ensureDay(ds);
  });

  Object.keys(byDate).forEach(function (ds) {
    var statuses = slotStatusesByDate[ds];
    if (!statuses) return;
    Object.keys(statuses).forEach(function (t) {
      if (!t) return;
      if (byDate[ds].slots[t] == null) byDate[ds].slots[t] = { newCount: 0, checkedCount: 0 };
    });
  });

  var dates = Object.keys(byDate).sort();
  if (dates.length === 0) {
    dailyOverviewEl.innerHTML = '<div class="empty-state">No upcoming bookings.</div>';
    return;
  }

  var maxSlotBookings = 0;
  var maxTotal = 0;
  dates.forEach(function (ds) {
    var day = byDate[ds];
    var slots = day.slots;
    Object.keys(slots).forEach(function (t) {
      var c = slots[t].newCount + slots[t].checkedCount;
      if (c > maxSlotBookings) maxSlotBookings = c;
    });
    var t = day.newCount + day.checkedCount;
    if (t > maxTotal) maxTotal = t;
  });
  if (maxSlotBookings === 0) maxSlotBookings = 1;
  if (maxTotal === 0) maxTotal = 1;

  var html = '<div class="daily-list">';
  dates.forEach(function (ds) {
    var d = byDate[ds];
    var total = d.newCount + d.checkedCount;
    var rowClasses = ["daily-row"];
    if (ds === today) rowClasses.push("daily-today");
    if (total === 0) rowClasses.push("daily-empty");

    html += '<div class="' + rowClasses.join(" ") + '">';

    var totalWidthPct = (total / maxTotal) * 100;
    var newPct = total > 0 ? (d.newCount / total) * 100 : 0;
    var checkedPct = total > 0 ? (d.checkedCount / total) * 100 : 0;
    html += '<div class="daily-bar-wrap">';
    if (total === 0) {
      html += '<div class="daily-bar" style="width:4px"></div>';
    } else {
      html += '<div class="daily-bar" style="width:' + totalWidthPct.toFixed(2) + '%">';
      if (d.newCount > 0) {
        html += '<div class="daily-bar-segment daily-bar-new" style="width:' + newPct.toFixed(2) + '%">' + d.newCount + "</div>";
      }
      if (d.checkedCount > 0) {
        html += '<div class="daily-bar-segment daily-bar-checked" style="width:' + checkedPct.toFixed(2) + '%">' + d.checkedCount + "</div>";
      }
      html += "</div>";
    }
    html += "</div>";

    html += '<div class="daily-date">';
    html += '<span class="daily-weekday">' + escapeHtml(formatWeekday(ds)) + (ds === today ? " · idag" : "") + "</span>";
    html += '<span class="daily-datestr">' + escapeHtml(ds) + "</span>";
    html += "</div>";

    var peopleTotal = d.adults + d.kids + d.pens;
    html += '<div class="daily-totals"><div class="daily-total-people">';
    html += '<div class="daily-total-row"><span class="daily-total-bookings">' + total + '</span><span class="daily-total-label">bokningar</span></div>';
    html += '<div class="daily-total-breakdown">' + peopleTotal + " st : " + d.kids + "b/" + d.adults + "v/" + d.pens + "p</div>";
    var estIncome = Math.round((d.kids * ENTRANCE_FEES.kids + d.adults * ENTRANCE_FEES.adults + d.pens * ENTRANCE_FEES.pensioners) * INCOME_MULTIPLIER);
    html += '<div class="daily-total-income" title="Uppskattad entréintäkt">~' + estIncome.toLocaleString("sv-SE") + " kr</div>";
    var estBurgers = Math.max(0, Math.round(HAMBURGER_FIT.slope * peopleTotal + HAMBURGER_FIT.intercept));
    html += '<div class="daily-total-burgers" title="Uppskattat antal hamburgare">≈ ' + estBurgers.toLocaleString("sv-SE") + " hamburgare</div>";
    html += "</div></div>";

    html += '<div class="daily-slots">';

    var slotTimes = Object.keys(d.slots).sort();
    if (slotTimes.length === 0) {
      html += '<div class="daily-slots-empty">Inga bokningar</div>';
    } else {
      var dsNorm = normalizeDateStr(ds);
      var dsIso = dsNorm.length === 8 ? dsNorm.slice(0, 4) + "-" + dsNorm.slice(4, 6) + "-" + dsNorm.slice(6, 8) : ds;
      slotTimes.forEach(function (t) {
        var slot = d.slots[t];
        var slotTotal = slot.newCount + slot.checkedCount;
        var pct = (slotTotal / maxSlotBookings) * 100;
        var newPct = slotTotal > 0 ? (slot.newCount / slotTotal) * 100 : 0;
        var checkedPct = slotTotal > 0 ? (slot.checkedCount / slotTotal) * 100 : 0;
        var w = t ? weatherByHour[dsIso + " " + t] : null;
        var weatherHtml = w && WEATHER_EMOJI[w.symbol]
          ? '<span class="daily-slot-weather" title="SMHI">' + WEATHER_EMOJI[w.symbol] + " " + w.temp + "°</span>"
          : '<span class="daily-slot-weather daily-slot-weather-empty"></span>';
        html += '<div class="daily-slot">';
        html += weatherHtml;
        html += '<span class="daily-slot-time">' + escapeHtml(t || "—") + "</span>";
        html += '<span class="daily-slot-line-wrap">';
        if (slotTotal > 0) {
          html += '<span class="daily-slot-line" style="width:' + pct.toFixed(2) + '%">';
          if (slot.newCount > 0) {
            html += '<span class="daily-slot-seg daily-bar-new" style="width:' + newPct.toFixed(2) + '%">' + slot.newCount + '</span>';
          }
          if (slot.checkedCount > 0) {
            html += '<span class="daily-slot-seg daily-bar-checked" style="width:' + checkedPct.toFixed(2) + '%">' + slot.checkedCount + '</span>';
          }
          html += "</span>";
        }
        html += "</span>";
        html += "</div>";
      });
    }
    html += "</div>";

    html += "</div>";
  });
  html += "</div>";

  dailyOverviewEl.innerHTML = html;
}

// ── Sort state ────────────────────────────────────────────────────
const COLUMNS = [
  { key: "dateStr", label: "Date", type: "string" },
  { key: "timeStr", label: "Time", type: "string" },
  { key: "name", label: "Name", type: "string" },
  { key: "email", label: "Email", type: "string" },
  { key: "numberOfKids", label: "Kids", type: "number" },
  { key: "numberOfAdults", label: "Adults", type: "number" },
  { key: "numberOfPensioners", label: "Pens", type: "number" },
  { key: "status", label: "Status", type: "string" },
  { key: "created", label: "Created", type: "string" },
  { key: "bookingId", label: "ID", type: "string" },
];

function toBookingCount(v) {
  if (v == null) return 0;
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

var sortState = loadSortState();

function loadSortState() {
  try {
    var raw = localStorage.getItem(SORT_STORAGE_KEY);
    if (raw) {
      var parsed = JSON.parse(raw);
      if (parsed && COLUMNS.some(function (c) { return c.key === parsed.key; }) &&
          (parsed.dir === "asc" || parsed.dir === "desc")) {
        return { key: parsed.key, dir: parsed.dir };
      }
    }
  } catch (e) {}
  return { key: "dateStr", dir: "asc" };
}

function persistSortState() {
  try { localStorage.setItem(SORT_STORAGE_KEY, JSON.stringify(sortState)); } catch (e) {}
}

function compareBookings(a, b, key, dir) {
  var col = COLUMNS.find(function (c) { return c.key === key; }) || { type: "string" };
  var av = a[key];
  var bv = b[key];
  var cmp;
  if (col.type === "number") {
    var an = (typeof av === "number") ? av : -Infinity;
    var bn = (typeof bv === "number") ? bv : -Infinity;
    cmp = an - bn;
  } else {
    var as = av == null ? "" : String(av);
    var bs = bv == null ? "" : String(bv);
    cmp = as.localeCompare(bs, undefined, { numeric: true, sensitivity: "base" });
  }
  if (cmp === 0 && key !== "bookingId") {
    cmp = String(a.bookingId || "").localeCompare(String(b.bookingId || ""));
  }
  return dir === "desc" ? -cmp : cmp;
}

// ── Render table ──────────────────────────────────────────────────
function renderTable() {
  tableContainer.innerHTML = "";
  if (filteredBookings.length === 0) {
    tableContainer.innerHTML = '<div class="empty-state">No bookings found.</div>';
    return;
  }

  var sortedBookings = filteredBookings.slice().sort(function (a, b) {
    return compareBookings(a, b, sortState.key, sortState.dir);
  });

  var start = (currentPage - 1) * PAGE_SIZE;
  var pageItems = sortedBookings.slice(start, start + PAGE_SIZE);

  var html = '<div class="table-scroll"><table class="booking-table"><thead><tr>';
  COLUMNS.forEach(function (col) {
    var active = sortState.key === col.key;
    var indicator = active ? (sortState.dir === "asc" ? "▲" : "▼") : "↕";
    var thClasses = ["sortable-header"];
    if (active) thClasses.push("sortable-active");
    var ariaSort = active ? (sortState.dir === "asc" ? "ascending" : "descending") : "none";
    html += '<th class="' + thClasses.join(" ") + '" data-sort-key="' + col.key + '" aria-sort="' + ariaSort + '">';
    html += '<button type="button" class="sort-button" data-sort-key="' + col.key + '">';
    html += '<span class="sort-label">' + col.label + '</span>';
    html += '<span class="sort-indicator" aria-hidden="true">' + indicator + '</span>';
    html += '</button>';
    html += '</th>';
  });
  html += "</tr></thead><tbody>";

  pageItems.forEach(function (b, idx) {
    var validStatuses = ["NEW", "REMOVED", "CHECKED_IN"];
    var status = (typeof b.status === "string" && validStatuses.includes(b.status)) ? b.status : "NEW";
    var globalIdx = start + idx;

    var dateOptions = availableDates.slice();
    if (b.dateStr && !dateOptions.includes(b.dateStr)) {
      dateOptions.push(b.dateStr);
      dateOptions.sort();
    }

    html += "<tr>";

    // Date
    html += '<td><select data-idx="' + globalIdx + '" class="date-select" aria-label="Booking date for ' + escapeHtml(b.name) + '">';
    dateOptions.forEach(function (d) {
      html += '<option value="' + d + '"' + (b.dateStr === d ? " selected" : "") + ">" + d + "</option>";
    });
    html += "</select></td>";

    // Time
    html += '<td><select data-idx="' + globalIdx + '" class="time-select" aria-label="Booking time for ' + escapeHtml(b.name) + '">';
    ["10:00", "11:00", "12:00", "13:00"].forEach(function (t) {
      html += '<option value="' + t + '"' + (b.timeStr === t ? " selected" : "") + ">" + t + "</option>";
    });
    html += "</select></td>";

    // Name
    html += '<td class="cell-name"><input type="text" data-idx="' + globalIdx + '" class="name-input" value="' + escapeAttr(b.name) + '" aria-label="Name for booking" /></td>';

    // Email
    html += '<td class="cell-email"><input type="email" data-idx="' + globalIdx + '" class="email-input" value="' + escapeAttr(b.email) + '" aria-label="Email for booking" /></td>';

    var kids = toBookingCount(b.numberOfKids);
    var adults = toBookingCount(b.numberOfAdults != null ? b.numberOfAdults : b.numberOfPeople);
    var pens = toBookingCount(b.numberOfPensioners);

    // Kids
    html += '<td><select data-idx="' + globalIdx + '" class="kids-select" aria-label="Number of kids for ' + escapeHtml(b.name) + '">';
    for (var j = 0; j <= 10; j++) {
      html += '<option value="' + j + '"' + (kids === j ? " selected" : "") + ">" + j + "</option>";
    }
    html += "</select></td>";

    // Adults
    html += '<td><select data-idx="' + globalIdx + '" class="adults-select" aria-label="Number of adults for ' + escapeHtml(b.name) + '">';
    for (var i = 1; i <= 10; i++) {
      html += '<option value="' + i + '"' + (adults === i ? " selected" : "") + ">" + i + "</option>";
    }
    html += "</select></td>";

    // Pensioners
    html += '<td><select data-idx="' + globalIdx + '" class="pens-select" aria-label="Number of pensioners for ' + escapeHtml(b.name) + '">';
    for (var k = 0; k <= 10; k++) {
      html += '<option value="' + k + '"' + (pens === k ? " selected" : "") + ">" + k + "</option>";
    }
    html += "</select></td>";

    // Status
    html += '<td><select data-idx="' + globalIdx + '" class="status-select" data-status="' + status + '" aria-label="Status for ' + escapeHtml(b.name) + '">';
    validStatuses.forEach(function (s) {
      html += '<option value="' + s + '"' + (status === s ? " selected" : "") + ">" + s + "</option>";
    });
    html += "</select></td>";

    // Created
    html += '<td class="cell-date">' + (b.created ? new Date(b.created).toLocaleString() : "") + "</td>";

    // ID
    html += '<td class="cell-id">' + escapeHtml(b.bookingId) + "</td>";

    html += "</tr>";
  });

  html += "</tbody></table></div>";
  tableContainer.innerHTML = html;
  updateBookingStats();

  // Attach change listeners
  attachSelectListeners(sortedBookings);
  attachSortListeners();
}

function attachSortListeners() {
  document.querySelectorAll(".sort-button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var key = this.getAttribute("data-sort-key");
      if (sortState.key === key) {
        sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
      } else {
        sortState.key = key;
        sortState.dir = "asc";
      }
      persistSortState();
      currentPage = 1;
      renderTable();
      renderPagination();
    });
  });
}

function attachSelectListeners(sortedBookings) {
  document.querySelectorAll(".date-select").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var booking = sortedBookings[parseInt(this.getAttribute("data-idx"))];
      if (!booking || booking.dateStr === this.value) return;
      updateBookingField(booking.bookingId, "dateStr", this.value, this);
    });
  });

  document.querySelectorAll(".time-select").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var booking = sortedBookings[parseInt(this.getAttribute("data-idx"))];
      if (!booking || booking.timeStr === this.value) return;
      updateBookingField(booking.bookingId, "timeStr", this.value, this);
    });
  });

  document.querySelectorAll(".adults-select").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var booking = sortedBookings[parseInt(this.getAttribute("data-idx"))];
      var val = parseInt(this.value);
      if (!booking || booking.numberOfAdults === val) return;
      updateBookingField(booking.bookingId, "numberOfAdults", val, this);
    });
  });

  document.querySelectorAll(".kids-select").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var booking = sortedBookings[parseInt(this.getAttribute("data-idx"))];
      var val = parseInt(this.value);
      if (!booking || booking.numberOfKids === val) return;
      updateBookingField(booking.bookingId, "numberOfKids", val, this);
    });
  });

  document.querySelectorAll(".pens-select").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var booking = sortedBookings[parseInt(this.getAttribute("data-idx"))];
      var val = parseInt(this.value);
      var current = (typeof booking.numberOfPensioners === "number") ? booking.numberOfPensioners : 0;
      if (!booking || current === val) return;
      updateBookingField(booking.bookingId, "numberOfPensioners", val, this);
    });
  });

  document.querySelectorAll(".status-select").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var booking = sortedBookings[parseInt(this.getAttribute("data-idx"))];
      if (!booking || booking.status === this.value) return;
      this.setAttribute("data-status", this.value);
      updateBookingField(booking.bookingId, "status", this.value, this);
    });
  });

  attachTextInputListener(".name-input", "name", sortedBookings, function (v) {
    return v.trim() ? v.trim() : null;
  });

  attachTextInputListener(".email-input", "email", sortedBookings, function (v) {
    var trimmed = v.trim();
    if (!trimmed) return null;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
    return trimmed;
  });
}

function attachTextInputListener(selector, field, sortedBookings, validate) {
  document.querySelectorAll(selector).forEach(function (input) {
    var initial = input.value;
    input.addEventListener("blur", function () {
      var validated = validate(this.value);
      if (validated == null) { this.value = initial; return; }
      var booking = sortedBookings[parseInt(this.getAttribute("data-idx"))];
      if (!booking || booking[field] === validated) {
        this.value = validated;
        return;
      }
      this.value = validated;
      updateBookingField(booking.bookingId, field, validated, this);
    });
    input.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") this.blur();
      if (evt.key === "Escape") { this.value = initial; this.blur(); }
    });
  });
}

// ── Update modal ──────────────────────────────────────────────────
function showUpdateModal() {
  updateModal.classList.add("visible");
}

function hideUpdateModal() {
  updateModal.classList.remove("visible");
}

// ── Booking field update ──────────────────────────────────────────
function updateBookingField(bookingId, field, value, selectEl) {
  selectEl.disabled = true;
  showUpdateModal();
  var booking = allBookings.find(function (b) { return b.bookingId === bookingId; });
  if (!booking) {
    alert("Booking not found");
    selectEl.disabled = false;
    hideUpdateModal();
    return;
  }
  booking[field] = value;
  var url = API_BASE + "/bookings/" + bookingId + "?admin=" + encodeURIComponent(adminPwd);
  fetchJson(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(booking),
  })
    .then(function () {
      showToast("Updated " + field + " for " + booking.name);
      renderTable();
      renderPagination();
    })
    .catch(function (err) {
      showError("Save failed (" + field + " for " + booking.name + "): " + err.message);
      selectEl.disabled = false;
    })
    .finally(hideUpdateModal);
}

// ── Pagination ────────────────────────────────────────────────────
function renderPagination() {
  paginationDiv.innerHTML = "";
  var pageCount = Math.ceil(filteredBookings.length / PAGE_SIZE);
  if (pageCount <= 1) return;

  for (var i = 1; i <= pageCount; i++) {
    (function (page) {
      var btn = document.createElement("button");
      btn.textContent = page;
      btn.setAttribute("aria-label", "Go to page " + page);
      if (page === currentPage) {
        btn.disabled = true;
        btn.setAttribute("aria-current", "page");
      }
      btn.addEventListener("click", function () {
        currentPage = page;
        renderTable();
        renderPagination();
        tableContainer.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      paginationDiv.appendChild(btn);
    })(i);
  }
}

// ── Email Templates ───────────────────────────────────────────────
function fetchEmailTemplates() {
  templatesList.innerHTML = '<div class="empty-state">Loading templates...</div>';

  return fetchJson(API_BASE + "/email-templates?admin=" + encodeURIComponent(adminPwd))
    .then(function (data) {
      allTemplates = data.templates || [];
      allPlaceholders = data.placeholders || [];
      renderTemplatesList();
    })
    .catch(function (err) {
      templatesList.innerHTML = "";
      showError(err.message);
    });
}

function renderTemplatesList() {
  templatesList.innerHTML = "";
  var activeTemplates = allTemplates.filter(function (t) { return t.active; });
  if (activeTemplates.length === 0) {
    templatesList.innerHTML = '<div class="empty-state">No active templates.</div>';
    return;
  }

  activeTemplates.forEach(function (tpl) {
    var card = document.createElement("div");
    card.className = "template-card";
    card.setAttribute("role", "button");
    card.setAttribute("tabindex", "0");
    card.setAttribute("aria-label", "Edit template " + tpl.name);
    card.innerHTML =
      '<div class="template-info">' +
        '<div class="template-name">' +
          escapeHtml(tpl.name) +
          ' <span class="badge ' + (tpl.active ? "badge-active" : "badge-inactive") + '">' +
            (tpl.active ? "Active" : "Inactive") +
          "</span>" +
        "</div>" +
        '<div class="template-meta">Type: ' + escapeHtml(tpl.type) +
          (tpl.updated ? " &middot; Updated: " + new Date(tpl.updated).toLocaleString() : "") +
        "</div>" +
        '<div class="template-subject">Subject: ' + escapeHtml(tpl.subject) + "</div>" +
      "</div>";

    card.addEventListener("click", function () { openEditor(tpl); });
    card.addEventListener("keydown", function (evt) {
      if (evt.key === "Enter") openEditor(tpl);
    });

    templatesList.appendChild(card);
  });
}

// ── Template Editor Modal ─────────────────────────────────────────
// Track last focused text field in the editor for placeholder insertion
var lastFocusedField = null;

tplNameInput.addEventListener("focus", function () { lastFocusedField = this; });
tplSubjectInput.addEventListener("focus", function () { lastFocusedField = this; });
tplBodyInput.addEventListener("focus", function () { lastFocusedField = this; });

function renderPlaceholderSidebar() {
  placeholderListEl.innerHTML = "";
  if (allPlaceholders.length === 0) {
    editorSidebar.style.display = "none";
    return;
  }
  editorSidebar.style.display = "";
  allPlaceholders.forEach(function (p) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "placeholder-chip";
    btn.innerHTML = escapeHtml(p.placeholder) +
      (p.description ? '<span class="placeholder-desc">' + escapeHtml(p.description) + "</span>" : "");
    btn.setAttribute("aria-label", "Insert " + p.placeholder);
    btn.addEventListener("mousedown", function (evt) {
      // mousedown so we don't steal focus before we read cursor position
      evt.preventDefault();
    });
    btn.addEventListener("click", function () {
      insertPlaceholder(p.placeholder);
    });
    placeholderListEl.appendChild(btn);
  });
}

function insertPlaceholder(text) {
  var field = lastFocusedField;
  if (!field) field = tplBodyInput;
  var start = field.selectionStart;
  var end = field.selectionEnd;
  var val = field.value;
  field.value = val.substring(0, start) + text + val.substring(end);
  var newPos = start + text.length;
  field.setSelectionRange(newPos, newPos);
  field.focus();
  renderEmailPreview();
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function substitutePlaceholders(text) {
  var out = text || "";
  allPlaceholders.forEach(function (p) {
    if (!p.placeholder) return;
    var re = new RegExp(escapeRegExp(p.placeholder), "g");
    out = out.replace(re, p.exampleValue != null ? p.exampleValue : "");
  });
  return out;
}

function renderEmailPreview() {
  var previewSubject = document.getElementById("previewSubject");
  var previewBody = document.getElementById("previewBody");
  var previewTo = document.getElementById("previewTo");
  if (!previewSubject || !previewBody) return;

  var subject = substitutePlaceholders(tplSubjectInput.value);
  var body = substitutePlaceholders(tplBodyInput.value);

  previewSubject.textContent = subject || "(no subject)";
  previewSubject.classList.toggle("preview-empty", !subject);
  previewBody.textContent = body || "(empty body)";
  previewBody.classList.toggle("preview-empty", !body);

  var toExample = (allPlaceholders.find(function (p) { return p.key === "email"; }) || {}).exampleValue;
  if (previewTo && toExample) previewTo.textContent = toExample;
}

tplSubjectInput.addEventListener("input", renderEmailPreview);
tplBodyInput.addEventListener("input", renderEmailPreview);

function openEditor(tpl) {
  lastFocusedField = null;
  renderPlaceholderSidebar();
  if (tpl) {
    editingTemplateId = tpl.templateId;
    editorTitle.textContent = "Edit template";
    tplTypeSelect.value = tpl.type;
    tplTypeSelect.disabled = true;
    tplNameInput.value = tpl.name;
    tplSubjectInput.value = tpl.subject;
    tplBodyInput.value = tpl.body;
    tplActiveInput.checked = !!tpl.active;
  } else {
    editingTemplateId = null;
    editorTitle.textContent = "New template";
    tplTypeSelect.value = "";
    tplTypeSelect.disabled = false;
    tplNameInput.value = "";
    tplSubjectInput.value = "";
    tplBodyInput.value = "";
    tplActiveInput.checked = false;
  }
  editorModal.classList.add("visible");
  renderEmailPreview();
  (tpl ? tplNameInput : tplTypeSelect).focus();
}

function closeEditor() {
  editorModal.classList.remove("visible");
  editingTemplateId = null;
}

cancelTemplateBtn.addEventListener("click", closeEditor);
editorCloseBtn.addEventListener("click", closeEditor);

// Close modal on backdrop click
editorModal.addEventListener("click", function (evt) {
  if (evt.target === editorModal) closeEditor();
});

// Close modal on Escape
document.addEventListener("keydown", function (evt) {
  if (evt.key === "Escape" && editorModal.classList.contains("visible")) {
    closeEditor();
  }
});

saveTemplateBtn.addEventListener("click", function () {
  var type = tplTypeSelect.value;
  var name = tplNameInput.value.trim();
  var subject = tplSubjectInput.value.trim();
  var body = tplBodyInput.value;
  var active = tplActiveInput.checked;

  if (!type || !name || !subject || !body) {
    showError("All fields are required.");
    return;
  }

  showUpdateModal();

  if (editingTemplateId) {
    // PUT update
    fetchJson(API_BASE + "/email-templates/" + editingTemplateId + "?admin=" + encodeURIComponent(adminPwd), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, subject: subject, body: body, active: active }),
    })
      .then(function () {
        closeEditor();
        showToast('Template "' + name + '" updated.');
        fetchEmailTemplates();
      })
      .catch(function (err) {
        showError(err.message);
      })
      .finally(hideUpdateModal);
  } else {
    // POST create — use type as templateId
    var templateId = type;
    fetchJson(API_BASE + "/email-templates?admin=" + encodeURIComponent(adminPwd), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: templateId, type: type, name: name, subject: subject, body: body, active: active }),
    })
      .then(function () {
        closeEditor();
        showToast('Template "' + name + '" created.');
        fetchEmailTemplates();
      })
      .catch(function (err) {
        showError(err.message);
      })
      .finally(hideUpdateModal);
  }
});

// ── Toast notification ────────────────────────────────────────────
function showToast(message, opts) {
  opts = opts || {};
  var isError = !!opts.error;
  var duration = opts.duration != null ? opts.duration : (isError ? 5000 : 2500);
  var toast = document.createElement("div");
  toast.className = "toast" + (isError ? " toast-error" : "");
  toast.setAttribute("role", isError ? "alert" : "status");
  toast.setAttribute("aria-live", isError ? "assertive" : "polite");
  toast.textContent = message;
  document.body.appendChild(toast);

  requestAnimationFrame(function () {
    toast.classList.add("visible");
  });

  setTimeout(function () {
    toast.classList.remove("visible");
    setTimeout(function () {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 200);
  }, duration);
}

function showError(message) {
  showToast(message, { error: true });
}

// ── Slot Configs (calendar view) ──────────────────────────────────
function pad2(n) { return (n < 10 ? "0" : "") + n; }

function dateStrFromYMD(y, m, d) {
  // m and d are 1-indexed
  return "" + y + pad2(m) + pad2(d);
}

function formatDateStr(dateStr) {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  return dateStr.slice(0, 4) + "-" + dateStr.slice(4, 6) + "-" + dateStr.slice(6, 8);
}

function formatDateStrLong(dateStr) {
  if (!dateStr || dateStr.length !== 8) return dateStr;
  var y = parseInt(dateStr.slice(0, 4), 10);
  var m = parseInt(dateStr.slice(4, 6), 10) - 1;
  var d = parseInt(dateStr.slice(6, 8), 10);
  var dt = new Date(y, m, d);
  return dt.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });
}

function fetchSlotConfigs() {
  return fetchJson(API_BASE + "/slot-configs?admin=" + encodeURIComponent(adminPwd))
    .then(function (data) {
      slotConfigByDate = {};
      (Array.isArray(data) ? data : []).forEach(function (cfg) {
        slotConfigByDate[cfg.dateStr] = cfg;
      });
      if (calYear === 0) {
        var now = new Date();
        calYear = now.getFullYear();
        calMonth = now.getMonth();
      }
      renderCalendar();
      if (selectedDateStr) renderDayDetail();
    })
    .catch(function (err) {
      showError(err.message);
    });
}

function renderCalendar() {
  var monthDate = new Date(calYear, calMonth, 1);
  calTitle.textContent = monthDate.toLocaleDateString(undefined, { month: "long", year: "numeric" });

  var firstDay = new Date(calYear, calMonth, 1).getDay(); // 0=Sun
  var leading = (firstDay + 6) % 7; // Monday-first
  var daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();

  var todayStr = (function () {
    var t = new Date();
    return dateStrFromYMD(t.getFullYear(), t.getMonth() + 1, t.getDate());
  })();

  var html = "";
  for (var i = 0; i < leading; i++) {
    html += '<div class="cal-cell cal-empty"></div>';
  }
  for (var d = 1; d <= daysInMonth; d++) {
    var ds = dateStrFromYMD(calYear, calMonth + 1, d);
    var cfg = slotConfigByDate[ds];
    var classes = ["cal-cell", "cal-day"];
    if (cfg && cfg.isOpen) classes.push("cal-open");
    else if (cfg && !cfg.isOpen) classes.push("cal-closed");
    if (ds === selectedDateStr) classes.push("cal-selected");
    if (ds === todayStr) classes.push("cal-today");
    html += '<button type="button" class="' + classes.join(" ") + '" data-date="' + ds + '">' +
      '<span class="cal-daynum">' + d + "</span>" +
      (cfg && cfg.isOpen ? '<span class="cal-slotcount">' + (cfg.timeSlots || []).length + " slots</span>" : "") +
      "</button>";
  }
  calendarGrid.innerHTML = html;

  calendarGrid.querySelectorAll(".cal-day").forEach(function (btn) {
    btn.addEventListener("click", function () {
      selectedDateStr = this.getAttribute("data-date");
      renderCalendar();
      renderDayDetail();
    });
  });
}

calPrevBtn.addEventListener("click", function () {
  calMonth--;
  if (calMonth < 0) { calMonth = 11; calYear--; }
  renderCalendar();
});

calNextBtn.addEventListener("click", function () {
  calMonth++;
  if (calMonth > 11) { calMonth = 0; calYear++; }
  renderCalendar();
});

function rowsFromPreset(presetId) {
  var preset = SLOT_PRESETS.find(function (p) { return p.id === presetId; });
  if (!preset) return [];
  return preset.slots.map(function (s) {
    return { startTime: s.startTime, endTime: s.endTime, cap: s.maxPeopleForSlot, enabled: true };
  });
}

function rowsFromConfig(cfg) {
  return (cfg.timeSlots || []).map(function (ts) {
    return {
      startTime: ts.startTime,
      endTime: ts.endTime,
      cap: ts.maxPeopleForSlot != null ? ts.maxPeopleForSlot : DEFAULT_CAPACITY,
      enabled: true,
    };
  });
}

function detectPresetId(rows) {
  // Match rows (enabled only, same order) against a preset
  var enabled = rows.filter(function (r) { return r.enabled; });
  for (var i = 0; i < SLOT_PRESETS.length; i++) {
    var p = SLOT_PRESETS[i];
    if (enabled.length !== p.slots.length) continue;
    var match = true;
    for (var j = 0; j < p.slots.length; j++) {
      var r = enabled[j], s = p.slots[j];
      if (r.startTime !== s.startTime || r.endTime !== s.endTime || r.cap !== s.maxPeopleForSlot) {
        match = false; break;
      }
    }
    if (match) return p.id;
  }
  return "";
}

function renderHourSlotList(container, rows) {
  var statusesForDay = slotStatusesByDate[selectedDateStr] || {};
  container.innerHTML = rows.map(function (row) {
    var status = statusesForDay[row.startTime];
    var countHtml = "";
    if (status) {
      var kids = status.numberOfKids || 0;
      var ad = status.numberOfAdults || 0;
      var pens = status.numberOfPensioners || 0;
      var total = kids + ad + pens;
      var cls = total > 0 ? "hs-counts hs-counts-has" : "hs-counts";
      countHtml = '<span class="' + cls + '" title="kids / adults / pensioners = total">' +
        kids + '/' + ad + '/' + pens + ' = ' + total +
        '</span>';
    } else {
      countHtml = '<span class="hs-counts hs-counts-none">—</span>';
    }
    return '<label class="hour-slot-row">' +
      '<input type="checkbox" class="hs-enabled"' + (row.enabled ? " checked" : "") + ' data-start="' + row.startTime + '" data-end="' + row.endTime + '" />' +
      '<span class="hs-time">' + row.startTime + ' – ' + row.endTime + '</span>' +
      countHtml +
      '<input type="number" class="hs-cap" min="0" max="500" value="' + row.cap + '"' + (row.enabled ? "" : " disabled") + ' />' +
      '<span class="hs-cap-label">max</span>' +
      '</label>';
  }).join("");
  container.querySelectorAll(".hs-enabled").forEach(function (cb) {
    cb.addEventListener("change", function () {
      var cap = this.parentElement.querySelector(".hs-cap");
      cap.disabled = !this.checked;
    });
  });
}

function renderDayDetail() {
  if (!selectedDateStr) {
    dayDetail.innerHTML = '<div class="empty-state">Click a day to edit.</div>';
    return;
  }
  var cfg = slotConfigByDate[selectedDateStr];
  var isOpen = cfg ? !!cfg.isOpen : true;
  var rows = cfg ? rowsFromConfig(cfg) : rowsFromPreset(DEFAULT_PRESET_ID);
  var currentPresetId = detectPresetId(rows);

  var presetOptions = '<option value="">— Custom —</option>' +
    SLOT_PRESETS.map(function (p) {
      return '<option value="' + p.id + '"' + (p.id === currentPresetId ? " selected" : "") + ">" + escapeHtml(p.label) + "</option>";
    }).join("");

  var html = '';
  html += '<div class="day-detail-header">';
  html += '<h3 class="day-detail-title">' + escapeHtml(formatDateStrLong(selectedDateStr)) + '</h3>';
  if (cfg) {
    html += '<button class="btn-delete btn-delete-day" id="deleteDayBtn" type="button">Delete</button>';
  }
  html += '</div>';
  html += '<label class="open-toggle">';
  html += '<input type="checkbox" id="dayIsOpen"' + (isOpen ? " checked" : "") + ' />';
  html += '<span>Open this day</span>';
  html += '</label>';
  html += '<div class="form-field preset-field">';
  html += '<label for="presetSelect">Quick preset</label>';
  html += '<select id="presetSelect">' + presetOptions + '</select>';
  html += '</div>';
  html += '<div class="hour-slot-list" id="hourSlotList"></div>';
  html += '<div class="hour-slot-legend">Bookings per slot: <strong>kids</strong> / <strong>adults</strong> / <strong>pensioners</strong> = <strong>total</strong> &nbsp;·&nbsp; — = no data</div>';
  html += '<div class="day-detail-actions">';
  html += '<button class="btn-save" id="saveDayBtn" type="button">Save</button>';
  html += '</div>';

  dayDetail.innerHTML = html;

  var listEl = document.getElementById("hourSlotList");
  renderHourSlotList(listEl, rows);

  document.getElementById("presetSelect").addEventListener("change", function () {
    var presetRows = rowsFromPreset(this.value);
    if (presetRows.length) renderHourSlotList(listEl, presetRows);
  });

  document.getElementById("saveDayBtn").addEventListener("click", saveSelectedDay);
  var deleteBtn = document.getElementById("deleteDayBtn");
  if (deleteBtn) deleteBtn.addEventListener("click", function () { deleteSlotConfig(selectedDateStr); });
}

function saveSelectedDay() {
  if (!selectedDateStr) return;
  var isOpen = document.getElementById("dayIsOpen").checked;
  var rows = dayDetail.querySelectorAll(".hour-slot-row");
  var timeSlots = [];
  for (var i = 0; i < rows.length; i++) {
    var cb = rows[i].querySelector(".hs-enabled");
    if (!cb.checked) continue;
    var cap = parseInt(rows[i].querySelector(".hs-cap").value, 10);
    if (isNaN(cap) || cap < 0 || cap > 500) {
      showError("Max people must be 0–500.");
      return;
    }
    timeSlots.push({
      startTime: cb.getAttribute("data-start"),
      endTime: cb.getAttribute("data-end"),
      maxPeopleForSlot: cap,
    });
  }
  if (timeSlots.length < 1) {
    showError("Select at least one time slot.");
    return;
  }

  var existing = slotConfigByDate[selectedDateStr];
  var url, method, body;
  if (existing) {
    url = API_BASE + "/slot-configs/" + selectedDateStr + "?admin=" + encodeURIComponent(adminPwd);
    method = "PUT";
    body = { isOpen: isOpen, timeSlots: timeSlots };
  } else {
    url = API_BASE + "/slot-configs?admin=" + encodeURIComponent(adminPwd);
    method = "POST";
    body = { dateStr: selectedDateStr, isOpen: isOpen, timeSlots: timeSlots };
  }

  showUpdateModal();
  fetchJson(url, {
    method: method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(function () {
      showToast("Saved " + formatDateStr(selectedDateStr));
      return Promise.all([fetchSlotConfigs(), fetchAvailableDates()]);
    })
    .then(function () { if (selectedDateStr) renderDayDetail(); })
    .catch(function (err) { showError(err.message); })
    .finally(hideUpdateModal);
}

function deleteSlotConfig(dateStr) {
  if (!confirm("Delete slot config for " + formatDateStr(dateStr) + "?")) return;
  showUpdateModal();
  fetchJson(API_BASE + "/slot-configs/" + dateStr + "?admin=" + encodeURIComponent(adminPwd), {
    method: "DELETE",
  })
    .then(function () {
      showToast("Slot config deleted.");
      if (selectedDateStr === dateStr) selectedDateStr = null;
      return fetchSlotConfigs();
    })
    .then(function () { renderDayDetail(); })
    .catch(function (err) { showError(err.message); })
    .finally(hideUpdateModal);
}

// ── Utility ───────────────────────────────────────────────────────
function escapeHtml(str) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function escapeAttr(str) {
  return String(str == null ? "" : str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ── Stage badge ───────────────────────────────────────────────────
(function initStageBadge() {
  document.body.classList.add("body-stage-" + STAGE);
  var badge = document.getElementById("stageBadge");
  if (!badge) return;
  badge.textContent = STAGE.toUpperCase();
  badge.classList.add("stage-" + STAGE);
  badge.title = API_BASE + " (click to switch)";
  badge.addEventListener("click", function () {
    var next = STAGE === "prod" ? "dev" : "prod";
    if (!confirm("Switch environment to " + next.toUpperCase() + " and reload?")) return;
    try { localStorage.setItem(STAGE_STORAGE_KEY, next); } catch (e) {}
    var url = new URL(window.location.href);
    url.searchParams.delete("stage");
    window.location.replace(url.toString());
  });
})();

// ── Auto-login from localStorage ──────────────────────────────────
(function tryAutoLogin() {
  var saved = "";
  try { saved = localStorage.getItem(PWD_STORAGE_KEY) || ""; } catch (e) {}
  if (saved) {
    pwdInput.value = saved;
    setPwdBtn.click();
  }
})();
