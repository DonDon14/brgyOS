const rows = document.getElementById("rows");
const msg = document.getElementById("msg");
const filter = document.getElementById("statusFilter");
const refreshBtn = document.getElementById("refreshBtn");
const saveKeyBtn = document.getElementById("saveKeyBtn");
const adminKeyInput = document.getElementById("adminKey");

adminKeyInput.value = localStorage.getItem("brgyos_admin_key") || "";

saveKeyBtn.addEventListener("click", () => {
  localStorage.setItem("brgyos_admin_key", adminKeyInput.value.trim());
  setMsg("Admin key saved.");
  loadRequests();
});

refreshBtn.addEventListener("click", loadRequests);
filter.addEventListener("change", loadRequests);

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
    buttons.push(`<a href="${item.pdfUrl}" target="_blank" rel="noreferrer"><button class="secondary" type="button">Open PDF</button></a>`);
  }

  return `<div class="actions">${buttons.join("")}</div>`;
}

function render(items) {
  rows.innerHTML = items
    .map(
      (item) => `
      <tr>
        <td>${item.id}</td>
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
}

async function loadRequests() {
  try {
    const status = filter.value;
    setMsg("Loading requests...");
    const result = await api(`/api/admin/requests?status=${encodeURIComponent(status)}`);
    render(result.data || []);
    setMsg(`Loaded ${result.data.length} request(s).`);
  } catch (error) {
    rows.innerHTML = "";
    setMsg(error.message);
  }
}

loadRequests();
