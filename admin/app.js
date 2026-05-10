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
const loginForm = document.getElementById("loginForm");
const logoutBtn = document.getElementById("logoutBtn");
const requestModal = document.getElementById("requestModal");
const modalTitle = document.getElementById("modalTitle");
const modalBody = document.getElementById("modalBody");
const modalTimeline = document.getElementById("modalTimeline");
const modalPdfLink = document.getElementById("modalPdfLink");
const closeModalBtn = document.getElementById("closeModalBtn");
const snapshotText = document.getElementById("snapshotText");
const pendingCount = document.getElementById("pendingCount");
const approvedCount = document.getElementById("approvedCount");
const pdfReadyCount = document.getElementById("pdfReadyCount");
const releasedCount = document.getElementById("releasedCount");
let currentItems = [];
const isLoginPage = Boolean(loginForm);

if (adminKeyInput) {
  adminKeyInput.value = localStorage.getItem("brgyos_staff_key") || localStorage.getItem("brgyos_admin_key") || "";
}

if (!isLoginPage && !getAdminKey()) {
  redirectToLogin();
}

if (loginForm) {
  loginForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const key = (adminKeyInput?.value || "").trim();
    if (!key) {
      setMsg("Enter your staff password.", "error");
      return;
    }
    await signIn(key);
  });
}

if (logoutBtn) {
  logoutBtn.addEventListener("click", () => {
    clearStoredKeys();
    redirectToLogin();
  });
}

if (refreshBtn) refreshBtn.addEventListener("click", loadRequests);
if (filter) filter.addEventListener("change", loadRequests);
if (barangayFilter) barangayFilter.addEventListener("change", loadRequests);
if (exportBtn) exportBtn.addEventListener("click", () => downloadFile("/api/admin/export.csv", "brgyos-requests.csv"));
if (backupBtn) backupBtn.addEventListener("click", () => downloadFile("/api/admin/backup.json", "brgyos-backup.json"));
if (closeModalBtn && requestModal) closeModalBtn.addEventListener("click", () => requestModal.close());

function getAdminKey() {
  return localStorage.getItem("brgyos_staff_key") || localStorage.getItem("brgyos_admin_key") || "";
}

function clearStoredKeys() {
  localStorage.removeItem("brgyos_staff_key");
  localStorage.removeItem("brgyos_admin_key");
}

function redirectToLogin() {
  const currentPath = `${window.location.pathname}${window.location.search}`;
  const target = `/admin/login.html?next=${encodeURIComponent(currentPath)}`;
  window.location.replace(target);
}

function redirectAfterLogin() {
  const params = new URLSearchParams(window.location.search);
  const next = params.get("next");
  if (next && next.startsWith("/admin/") && !next.includes("login.html")) {
    window.location.assign(next);
    return;
  }
  window.location.assign("/admin/");
}

function setMsg(text, tone = "") {
  if (!msg) return;
  msg.textContent = text;
  msg.dataset.tone = tone;
}

async function signIn(key) {
  try {
    if (saveKeyBtn) saveKeyBtn.disabled = true;
    setMsg("Signing in...");
    const response = await fetch("/api/admin/barangays", {
      headers: { "x-admin-key": key },
    });
    if (!response.ok) {
      throw new Error(response.status === 401 ? "Invalid staff password." : `Sign in failed: ${response.status}`);
    }
    localStorage.setItem("brgyos_staff_key", key);
    localStorage.removeItem("brgyos_admin_key");
    setMsg("Signed in.", "success");
    redirectAfterLogin();
  } catch (error) {
    setMsg(error.message, "error");
  } finally {
    if (saveKeyBtn) saveKeyBtn.disabled = false;
  }
}

async function api(path, options = {}) {
  const headers = Object.assign({}, options.headers || {}, {
    "x-admin-key": getAdminKey(),
    "Content-Type": "application/json",
  });

  const response = await fetch(path, Object.assign({}, options, { headers }));
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && !isLoginPage) {
      clearStoredKeys();
      redirectToLogin();
      return {};
    }
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return response.json();
}

function fmtDate(iso) {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

function statusLabel(status) {
  const labels = {
    PENDING_APPROVAL: "Pending review",
    APPROVED: "Approved",
    PDF_GENERATED: "PDF ready",
    RELEASED: "Released",
  };
  return labels[status] || status || "-";
}

function clearNode(node) {
  if (!node) return;
  while (node.firstChild) node.removeChild(node.firstChild);
}

function td(text, className = "") {
  const cell = document.createElement("td");
  cell.textContent = text || "-";
  if (className) cell.className = className;
  return cell;
}

function makeStatusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `status-badge status-${String(status || "unknown").toLowerCase()}`;
  badge.textContent = statusLabel(status);
  return badge;
}

function makeOpenButton(item) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "link-btn";
  btn.textContent = item.id || "Open";
  btn.addEventListener("click", () => openModal(item));
  return btn;
}

function appendActions(container, item) {
  const actions = document.createElement("div");
  actions.className = "actions";

  const actionMap = {
    PENDING_APPROVAL: { label: "Approve + PDF", action: "approve" },
    PDF_GENERATED: { label: "Mark Released", action: "release" },
  };

  const nextAction = actionMap[item.status];
  if (nextAction) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = nextAction.label;
    btn.addEventListener("click", () => runRequestAction(item.id, nextAction.action, btn));
    actions.appendChild(btn);
  }

  if (item.pdfUrl) {
    const link = document.createElement("a");
    link.className = "secondary-link";
    link.href = item.pdfUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open PDF";
    actions.appendChild(link);
  }

  if (!actions.childElementCount) {
    const done = document.createElement("span");
    done.className = "muted";
    done.textContent = "No action needed";
    actions.appendChild(done);
  }

  container.appendChild(actions);
}

async function runRequestAction(id, action, button) {
  if (action === "release" && !window.confirm(`Mark ${id} as released?`)) return;
  try {
    button.disabled = true;
    setMsg(`Processing ${statusLabel(action).toLowerCase()} for ${id}...`);
    await api(`/api/admin/requests/${encodeURIComponent(id)}/${action}`, { method: "POST" });
    await loadRequests();
    setMsg(`Updated ${id}.`, "success");
  } catch (error) {
    button.disabled = false;
    setMsg(error.message, "error");
  }
}

function addDetail(container, label, value) {
  const row = document.createElement("div");
  row.className = "detail-row";
  const labelEl = document.createElement("span");
  labelEl.textContent = label;
  const valueEl = document.createElement("strong");
  valueEl.textContent = value || "-";
  row.append(labelEl, valueEl);
  container.appendChild(row);
}

function openModal(item) {
  if (!requestModal || !modalTitle || !modalBody || !modalTimeline || !modalPdfLink) return;
  modalTitle.textContent = `Request ${item.id}`;
  clearNode(modalBody);
  addDetail(modalBody, "Resident", item.fullName);
  addDetail(modalBody, "Document", item.documentType);
  addDetail(modalBody, "Address", item.address);
  addDetail(modalBody, "Purpose", item.purpose);
  addDetail(modalBody, "Pickup date", item.pickupDate);
  addDetail(modalBody, "Status", statusLabel(item.status));

  if (item.pdfUrl) {
    modalPdfLink.href = item.pdfUrl;
    modalPdfLink.style.display = "inline-block";
  } else {
    modalPdfLink.removeAttribute("href");
    modalPdfLink.style.display = "none";
  }

  clearNode(modalTimeline);
  const history = Array.isArray(item.history) ? item.history : [];
  if (!history.length) {
    const empty = document.createElement("li");
    empty.textContent = "No timeline yet.";
    modalTimeline.appendChild(empty);
  }
  for (const h of history) {
    const li = document.createElement("li");
    const at = document.createElement("strong");
    at.textContent = fmtDate(h.at);
    li.append(at, document.createTextNode(` - ${statusLabel(h.action)} (${h.note || "No note"})`));
    modalTimeline.appendChild(li);
  }

  requestModal.showModal();
}

function renderRequestRows(target, items, mode) {
  clearNode(target);
  if (!target) return;

  const visibleItems = mode === "history"
    ? items.filter((item) => item.status === "PDF_GENERATED" || item.status === "RELEASED")
    : items;

  if (!visibleItems.length) {
    const tr = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = mode === "history" ? 4 : 7;
    cell.className = "empty-state";
    cell.textContent = mode === "history" ? "No processed requests yet." : "No requests match this view.";
    tr.appendChild(cell);
    target.appendChild(tr);
    return;
  }

  for (const item of visibleItems) {
    const tr = document.createElement("tr");
    const refCell = document.createElement("td");
    refCell.appendChild(makeOpenButton(item));
    tr.appendChild(refCell);

    if (mode === "history") {
      tr.append(td(item.fullName));
      const statusCell = document.createElement("td");
      statusCell.appendChild(makeStatusBadge(item.status));
      tr.appendChild(statusCell);
      tr.append(td(fmtDate(item.updatedAt)));
    } else {
      tr.append(td(item.fullName));
      tr.append(td(item.documentType));
      tr.append(td(item.pickupDate || item.address));
      const statusCell = document.createElement("td");
      statusCell.appendChild(makeStatusBadge(item.status));
      tr.appendChild(statusCell);
      tr.append(td(fmtDate(item.updatedAt)));
      const actionCell = document.createElement("td");
      appendActions(actionCell, item);
      tr.appendChild(actionCell);
    }
    target.appendChild(tr);
  }
}

function render(items) {
  currentItems = items;
  if (rows) renderRequestRows(rows, items, "queue");
  if (historyRows) renderRequestRows(historyRows, items, "history");

  if (snapshotText) {
    const pending = items.filter((i) => i.status === "PENDING_APPROVAL").length;
    const approved = items.filter((i) => i.status === "APPROVED").length;
    const ready = items.filter((i) => i.status === "PDF_GENERATED").length;
    const done = items.filter((i) => i.status === "RELEASED").length;
    snapshotText.textContent = `Pending review: ${pending} | Approved: ${approved} | PDF ready: ${ready} | Released: ${done} | Total: ${items.length}`;
    if (pendingCount) pendingCount.textContent = pending;
    if (approvedCount) approvedCount.textContent = approved;
    if (pdfReadyCount) pdfReadyCount.textContent = ready;
    if (releasedCount) releasedCount.textContent = done;
  }
}

async function loadRequests() {
  const status = filter ? filter.value : "ALL";
  const barangayId = barangayFilter ? barangayFilter.value || "" : "";
  try {
    setMsg("Loading requests...");
    const result = await api(`/api/admin/requests?status=${encodeURIComponent(status)}&barangayId=${encodeURIComponent(barangayId)}`);
    const items = result.data || [];
    render(items);
    setMsg(`Loaded ${items.length} request(s).`, "success");
  } catch (error) {
    if (rows) clearNode(rows);
    if (historyRows) clearNode(historyRows);
    render([]);
    setMsg(error.message, "error");
  }
}

async function downloadFile(path, fallbackName) {
  if (!getAdminKey()) {
    redirectToLogin();
    return;
  }
  const barangayId = barangayFilter ? barangayFilter.value || "" : "";
  const url = path.includes("?")
    ? `${path}&barangayId=${encodeURIComponent(barangayId)}`
    : `${path}?barangayId=${encodeURIComponent(barangayId)}`;
  try {
    setMsg("Preparing download...");
    const response = await fetch(url, { headers: { "x-admin-key": getAdminKey() } });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || `Download failed: ${response.status}`);
    }
    const blob = await response.blob();
    const disposition = response.headers.get("Content-Disposition") || "";
    const fileName = disposition.match(/filename="([^"]+)"/)?.[1] || fallbackName;
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(objectUrl);
    setMsg("Download ready.", "success");
  } catch (error) {
    setMsg(error.message, "error");
  }
}

async function loadBarangays() {
  if (!barangayFilter) return;
  try {
    const result = await api("/api/admin/barangays");
    const items = result.data || [];
    clearNode(barangayFilter);
    const all = document.createElement("option");
    all.value = "";
    all.textContent = "All barangays";
    barangayFilter.appendChild(all);
    for (const b of items) {
      const option = document.createElement("option");
      option.value = b.id;
      option.textContent = b.name || b.id;
      barangayFilter.appendChild(option);
    }
  } catch {
    clearNode(barangayFilter);
    const fallback = document.createElement("option");
    fallback.value = "";
    fallback.textContent = "All barangays";
    barangayFilter.appendChild(fallback);
  }
}

async function loadPageData() {
  await loadBarangays();
  if (rows || historyRows || snapshotText) await loadRequests();
}

if (isLoginPage && getAdminKey()) {
  redirectAfterLogin();
} else if (!isLoginPage && getAdminKey()) {
  loadPageData();
}
