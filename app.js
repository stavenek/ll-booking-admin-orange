const STAGES = {
  dev: "https://95gewohkpj.execute-api.eu-north-1.amazonaws.com/dev/llb/v1",
  prod: "https://eay07x2tc7.execute-api.eu-north-1.amazonaws.com/prod/llb/v1",
};
const STAGE_STORAGE_KEY = "llStage";
const PWD_STORAGE_KEY = "llAdminPwd";

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
  return location.hostname.endsWith(".github.io") ? "prod" : "dev";
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

// ── Navigation tabs ───────────────────────────────────────────────
function switchTab(tabName) {
  document.querySelectorAll(".nav-tab").forEach(function (btn) {
    btn.classList.toggle("active", btn.getAttribute("data-tab") === tabName);
  });
  bookingsPanel.classList.toggle("visible", tabName === "bookings");
  templatesPanel.classList.toggle("visible", tabName === "templates");
  slotsPanel.classList.toggle("visible", tabName === "slots");
  if (tabName === "slots" && adminPwd) {
    refreshSlotCounts();
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
  Promise.all([fetchBookings(), fetchEmailTemplates(), fetchSlotConfigs()])
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
  errorDiv.textContent = "";
  filterContainer.classList.remove("visible");
  tableContainer.innerHTML = '<div class="empty-state">Loading...</div>';
  paginationDiv.innerHTML = "";

  return fetchAvailableDates()
    .then(function () {
      return fetch(API_BASE + "/bookings?admin=" + encodeURIComponent(adminPwd));
    })
    .then(function (res) {
      if (res.status === 400 || res.status === 401 || res.status === 403) {
        try { localStorage.removeItem(PWD_STORAGE_KEY); } catch (e) {}
        throw new Error("Wrong password — please log in again.");
      }
      if (!res.ok) throw new Error("Failed to fetch bookings (HTTP " + res.status + ")");
      return res.json();
    })
    .then(function (data) {
      allBookings = Array.isArray(data) ? data : [];
      filteredBookings = allBookings;
      filterContainer.classList.add("visible");
      navTabs.classList.add("visible");
      document.getElementById("statsCounter").classList.add("visible");
      bookingsPanel.classList.add("visible");
      currentPage = 1;
      renderTable();
      renderPagination();
      updateBookingStats();
      try { localStorage.setItem(PWD_STORAGE_KEY, adminPwd); } catch (e) {}
    })
    .catch(function (err) {
      tableContainer.innerHTML = "";
      errorDiv.textContent = err.message;
    });
}

function fetchAvailableDates() {
  return fetch(API_BASE + "/slots?admin=" + encodeURIComponent(adminPwd))
    .then(function (res) {
      if (!res.ok) throw new Error("Failed to fetch available dates");
      return res.json();
    })
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
filterInput.addEventListener("input", function (evt) {
  var term = evt.target.value.toLowerCase();
  filterBookings(term);
  currentPage = 1;
  renderTable();
  renderPagination();
});

function filterBookings(term) {
  if (!term) {
    filteredBookings = allBookings;
  } else {
    filteredBookings = allBookings.filter(function (b) {
      return Object.values(b).some(function (v) {
        return String(v).toLowerCase().includes(term);
      });
    });
  }
  updateBookingStats();
}

// ── Stats ─────────────────────────────────────────────────────────
function updateBookingStats() {
  totalBookingsSpan.textContent = allBookings.length;
  filteredBookingsSpan.textContent = filteredBookings.length;
}

// ── Render table ──────────────────────────────────────────────────
function renderTable() {
  tableContainer.innerHTML = "";
  if (filteredBookings.length === 0) {
    tableContainer.innerHTML = '<div class="empty-state">No bookings found.</div>';
    return;
  }

  var sortedBookings = filteredBookings.slice().sort(function (a, b) {
    var da = Date.parse(a.dateStr);
    var db = Date.parse(b.dateStr);
    if (!isNaN(da) && !isNaN(db)) return da - db;
    return a.dateStr.localeCompare(b.dateStr);
  });

  var start = (currentPage - 1) * PAGE_SIZE;
  var pageItems = sortedBookings.slice(start, start + PAGE_SIZE);
  var headers = ["Date", "Time", "Name", "Adults", "Kids", "Email", "Status", "Created", "ID"];

  var html = '<div class="table-scroll"><table class="booking-table"><thead><tr>';
  headers.forEach(function (h) { html += "<th>" + h + "</th>"; });
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
    html += '<td class="cell-name">' + escapeHtml(b.name) + "</td>";

    // Adults
    html += '<td><select data-idx="' + globalIdx + '" class="adults-select" aria-label="Number of adults for ' + escapeHtml(b.name) + '">';
    for (var i = 1; i <= 10; i++) {
      html += '<option value="' + i + '"' + (b.numberOfPeople == i ? " selected" : "") + ">" + i + "</option>";
    }
    html += "</select></td>";

    // Kids
    html += '<td><select data-idx="' + globalIdx + '" class="kids-select" aria-label="Number of kids for ' + escapeHtml(b.name) + '">';
    for (var j = 1; j <= 10; j++) {
      html += '<option value="' + j + '"' + (b.numberOfKids == j ? " selected" : "") + ">" + j + "</option>";
    }
    html += "</select></td>";

    // Email
    html += '<td class="cell-email">' + escapeHtml(b.email) + "</td>";

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
      if (!booking || booking.numberOfPeople === val) return;
      updateBookingField(booking.bookingId, "numberOfPeople", val, this);
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

  document.querySelectorAll(".status-select").forEach(function (sel) {
    sel.addEventListener("change", function () {
      var booking = sortedBookings[parseInt(this.getAttribute("data-idx"))];
      if (!booking || booking.status === this.value) return;
      this.setAttribute("data-status", this.value);
      updateBookingField(booking.bookingId, "status", this.value, this);
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
  fetch(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(booking),
  })
    .then(function (res) {
      if (!res.ok) throw new Error("Failed to save booking");
      showToast("Updated " + field + " for " + booking.name);
      renderTable();
      renderPagination();
    })
    .catch(function (err) {
      alert(err.message);
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
  emailError.textContent = "";
  templatesList.innerHTML = '<div class="empty-state">Loading templates...</div>';

  return fetch(API_BASE + "/email-templates?admin=" + encodeURIComponent(adminPwd))
    .then(function (res) {
      if (!res.ok) throw new Error("Failed to fetch email templates");
      return res.json();
    })
    .then(function (data) {
      allTemplates = data.templates || [];
      allPlaceholders = data.placeholders || [];
      renderTemplatesList();
    })
    .catch(function (err) {
      templatesList.innerHTML = "";
      emailError.textContent = err.message;
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
  editorError.textContent = "";
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
  editorError.textContent = "";

  var type = tplTypeSelect.value;
  var name = tplNameInput.value.trim();
  var subject = tplSubjectInput.value.trim();
  var body = tplBodyInput.value;
  var active = tplActiveInput.checked;

  if (!type || !name || !subject || !body) {
    editorError.textContent = "All fields are required.";
    return;
  }

  showUpdateModal();

  if (editingTemplateId) {
    // PUT update
    fetch(API_BASE + "/email-templates/" + editingTemplateId + "?admin=" + encodeURIComponent(adminPwd), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: name, subject: subject, body: body, active: active }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to update template");
        return res.json();
      })
      .then(function () {
        closeEditor();
        showToast('Template "' + name + '" updated.');
        fetchEmailTemplates();
      })
      .catch(function (err) {
        editorError.textContent = err.message;
      })
      .finally(hideUpdateModal);
  } else {
    // POST create — use type as templateId
    var templateId = type;
    fetch(API_BASE + "/email-templates?admin=" + encodeURIComponent(adminPwd), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ templateId: templateId, type: type, name: name, subject: subject, body: body, active: active }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error("Failed to create template");
        return res.json();
      })
      .then(function () {
        closeEditor();
        showToast('Template "' + name + '" created.');
        fetchEmailTemplates();
      })
      .catch(function (err) {
        editorError.textContent = err.message;
      })
      .finally(hideUpdateModal);
  }
});

// ── Toast notification ────────────────────────────────────────────
function showToast(message) {
  var toast = document.createElement("div");
  toast.className = "toast";
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
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
  }, 2500);
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
  slotsError.textContent = "";
  return fetch(API_BASE + "/slot-configs?admin=" + encodeURIComponent(adminPwd))
    .then(function (res) {
      if (!res.ok) throw new Error("Failed to fetch slot configs");
      return res.json();
    })
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
      slotsError.textContent = err.message;
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
      slotsError.textContent = "Max people must be 0–500.";
      return;
    }
    timeSlots.push({
      startTime: cb.getAttribute("data-start"),
      endTime: cb.getAttribute("data-end"),
      maxPeopleForSlot: cap,
    });
  }
  if (timeSlots.length < 1) {
    slotsError.textContent = "Select at least one time slot.";
    return;
  }
  slotsError.textContent = "";

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
  fetch(url, {
    method: method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
    .then(function (res) {
      if (!res.ok) throw new Error("Failed to save slot config");
      return res.json();
    })
    .then(function () {
      showToast("Saved " + formatDateStr(selectedDateStr));
      return Promise.all([fetchSlotConfigs(), fetchAvailableDates()]);
    })
    .then(function () { if (selectedDateStr) renderDayDetail(); })
    .catch(function (err) { slotsError.textContent = err.message; })
    .finally(hideUpdateModal);
}

function deleteSlotConfig(dateStr) {
  if (!confirm("Delete slot config for " + formatDateStr(dateStr) + "?")) return;
  showUpdateModal();
  fetch(API_BASE + "/slot-configs/" + dateStr + "?admin=" + encodeURIComponent(adminPwd), {
    method: "DELETE",
  })
    .then(function (res) {
      if (!res.ok) throw new Error("Failed to delete slot config");
      return res.json();
    })
    .then(function () {
      showToast("Slot config deleted.");
      if (selectedDateStr === dateStr) selectedDateStr = null;
      return fetchSlotConfigs();
    })
    .then(function () { renderDayDetail(); })
    .catch(function (err) { slotsError.textContent = err.message; })
    .finally(hideUpdateModal);
}

// ── Utility ───────────────────────────────────────────────────────
function escapeHtml(str) {
  var div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
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
