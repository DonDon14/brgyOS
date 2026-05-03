const rows = document.getElementById("rows");
const historyRows = document.getElementById("historyRows");
const msg = document.getElementById("msg");
const barangayFilter = document.getElementById("barangayFilter");
const filter = document.getElementById("statusFilter");
const refreshBtn = document.getElementById("refreshBtn");
const exportBtn = document.getElementById("exportBtn");
const backupBtn = document.getElementById("backupBtn");
const saveKeyBtn = document.getElementById("saveKeyBtn");
const adminKeyInput = document.getElementById("adminKey");
const requestModal = document.getElementById("requestModal");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalTimeline = document.getElementById("modalTimeline");
const modalPdfLink = document.getElementById("modalPdfLink");
const closeModalBtn = document.getElementById("closeModalBtn");
let currentItems = [];
let currentBarangays = [];

adminKeyInput.value = localStorage.getItem("brgyos_admin_key") || "";

saveKeyBtn.addEventListener("click", () => {
  localStorage.setItem("brgyos_admin_key", adminKeyInput.value.trim());
  setMsg("Admin key saved.");
  loadRequests();
});

refreshBtn.addEventListener("click", loadRequests);
filter.addEventListener("change", loadRequests);
barangayFilter.addEventListener("change", loadRequests);
exportBtn.addEventListener("click", downloadCsv);
backupBtn.addEventListener("click", downloadBackup);
closeModalBtn.addEventListener("click", () => requestModal.close());

function getAdminKey() {
  return localStorage.getItem("brgyos_admin_key") || "";
}

function setMsg(text) {
  msg.textContent = text;
}

async function api(path, options = {}) {
  const key = getAdminKey();
  const headers = Object.assign({}, options.headers || {}, {
    "x-admin-key": key,
    "Content-Type": "application/json",
  });

  const response = await fetch(path, Object.assign({}, options, { headers }));
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function fmtDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

function actionButtons(item) {
  const buttons = [];

  if (item.status === "PENDING_APPROVAL") {
    buttons.push(`<button data-action="approve" data-id="${item.id}">Approve</button>`);
  }
  if (item.status === "APPROVED") {
    buttons.push(`<button data-action="pdf" data-id="${item.id}">Generate PDF</button>`);
  }
  if (item.status === "PDF_GENERATED") {
    buttons.push(`<button data-action="release" data-id="${item.id}">Release</button>`);
  }
  if (item.pdfUrl) {
    buttons.push(`<a class="secondary-link" href="${item.pdfUrl}" target="_blank" rel="noreferrer">Open PDF</a>`);
  }

  return `<div class="actions">${buttons.join("")}</div>`;
}

function render(items) {
  currentItems = items;
  rows.innerHTML = items
    .map(
      (item) => `
      <tr data-id="${item.id}" class="clickable-row">
        <td><button data-open="${item.id}" class="link-btn">${item.id}</button></td>
        <td>${item.fullName || "-"}</td>
        <td>${item.documentType || "-"}</td>
        <td>${item.address || "-"}</td>
        <td class="status">${item.status}</td>
        <td>${fmtDate(item.updatedAt)}</td>
        <td>${actionButtons(item)}</td>
      </tr>
    `
    )
    .join("");
  historyRows.innerHTML = items
    .filter((item) => item.status === "PDF_GENERATED" || item.status === "RELEASED")
    .map(
      (item) => `
      <tr data-id="${item.id}" class="clickable-row">
        <td><button data-open="${item.id}" class="link-btn">${item.id}</button></td>
        <td>${item.fullName || "-"}</td>
        <td>${item.status}</td>
        <td>${fmtDate(item.updatedAt)}</td>
      </tr>
    `
    )
    .join("");

  rows.querySelectorAll("button[data-action]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const action = btn.dataset.action;
      try {
        setMsg(`Processing ${action} for ${id}...`);
        await api(`/api/admin/requests/${id}/${action}`, { method: "POST" });
        setMsg(`Done: ${action} ${id}`);
        await loadRequests();
      } catch (error) {
        setMsg(error.message);
      }
    });
  });

  document.querySelectorAll("button[data-open]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.dataset.open;
      const item = currentItems.find((x) => x.id === id);
      if (!item) return;
      openModal(item);
    });
  });
}

function openModal(item) {
  modalTitle.textContent = `Request ${item.id}`;
  modalBody.textContent =
    `Name: ${item.fullName || "-"}\n` +
    `Document: ${item.documentType || "-"}\n` +
    `Address: ${item.address || "-"}\n` +
    `Purpose: ${item.purpose || "-"}\n` +
    `Pickup Date: ${item.pickupDate || "-"}\n` +
    `Status: ${item.status}\n` +
    `Fee: PHP ${item.serviceFee || "-"}`;

  if (item.pdfUrl) {
    modalPdfLink.href = item.pdfUrl;
    modalPdfLink.style.display = "inline-block";
  } else {
    modalPdfLink.href = "#";
    modalPdfLink.style.display = "none";
  }

  const history = Array.isArray(item.history) ? item.history : [];
  modalTimeline.innerHTML = history
    .map((h) => `<li><strong>${fmtDate(h.at)}</strong> - ${h.action} (${h.note || "No note"})</li>`)
    .join("");

  requestModal.showModal();
}

async function loadRequests() {
  try {
    const status = filter.value;
    const barangayId = barangayFilter.value || "";
    setMsg("Loading requests...");
    const result = await api(`/api/admin/requests?status=${encodeURIComponent(status)}&barangayId=${encodeURIComponent(barangayId)}`);
    render(result.data || []);
    setMsg(`Loaded ${result.data.length} request(s).`);
  } catch (error) {
    rows.innerHTML = "";
    setMsg(error.message);
  }
}

async function downloadCsv() {
  const key = getAdminKey();
  if (!key) {
    setMsg("Set admin key first.");
    return;
  }
  const barangayId = barangayFilter.value || "";
  window.open(`/api/admin/export.csv?key=${encodeURIComponent(key)}&barangayId=${encodeURIComponent(barangayId)}`, "_blank");
}

async function downloadBackup() {
  const key = getAdminKey();
  if (!key) {
    setMsg("Set admin key first.");
    return;
  }
  window.open(`/api/admin/backup.json?key=${encodeURIComponent(key)}`, "_blank");
}

async function loadBarangays() {
  try {
    const result = await api("/api/owner/barangays");
    currentBarangays = result.data || [];
    barangayFilter.innerHTML = `<option value="">All</option>${currentBarangays
      .map((b) => `<option value="${b.id}">${b.name || b.id}</option>`)
      .join("")}`;
  } catch (_error) {
    barangayFilter.innerHTML = `<option value="">All</option>`;
  }
}

async function init() {
  await loadBarangays();
  await loadRequests();
}

init();
