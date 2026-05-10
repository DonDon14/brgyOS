const ownerKeyInput = document.getElementById("ownerKey");
const saveKeyBtn = document.getElementById("saveKeyBtn");
const msg = document.getElementById("msg");
const barangayRows = document.getElementById("barangayRows");
const staffRows = document.getElementById("staffRows");
const alertRows = document.getElementById("alertRows");
const staffBarangay = document.getElementById("staffBarangay");
const refreshAlertsBtn = document.getElementById("refreshAlertsBtn");
const ownerSnapshot = document.getElementById("ownerSnapshot");
const barangayCount = document.getElementById("barangayCount");
const staffCount = document.getElementById("staffCount");
const healthyTokenCount = document.getElementById("healthyTokenCount");
const tokenAlertCount = document.getElementById("tokenAlertCount");

if (ownerKeyInput) ownerKeyInput.value = localStorage.getItem("brgyos_owner_key") || "";
if (saveKeyBtn) {
  saveKeyBtn.addEventListener("click", () => {
    localStorage.setItem("brgyos_owner_key", (ownerKeyInput?.value || "").trim());
    setMsg("Owner access key saved for this browser.", "success");
    init();
  });
}
if (refreshAlertsBtn) refreshAlertsBtn.addEventListener("click", loadAlerts);

function setMsg(text, tone = "") {
  if (!msg) return;
  msg.textContent = text;
  msg.dataset.tone = tone;
}

function key() {
  return localStorage.getItem("brgyos_owner_key") || "";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      "x-admin-key": key(),
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  if (!response.ok) {
    const p = await response.json().catch(() => ({}));
    throw new Error(p.error || `Request failed: ${response.status}`);
  }
  return response.json();
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

function emptyRow(target, colSpan, text) {
  clearNode(target);
  const tr = document.createElement("tr");
  const cell = document.createElement("td");
  cell.colSpan = colSpan;
  cell.className = "empty-state";
  cell.textContent = text;
  tr.appendChild(cell);
  target.appendChild(tr);
}

async function loadBarangays() {
  const result = await api("/api/owner/barangays");
  const items = result.data || [];

  if (barangayRows) {
    clearNode(barangayRows);
    if (!items.length) {
      emptyRow(barangayRows, 6, "No barangays yet. Add your first pilot barangay above.");
    } else {
      for (const b of items) {
        const tr = document.createElement("tr");
        tr.append(
          td(b.id),
          td(b.name),
          td([b.municipality, b.province].filter(Boolean).join(", ")),
          td(b.captainName),
          td(b.secretaryName),
          td(b.pageId)
        );
        barangayRows.appendChild(tr);
      }
    }
  }

  if (staffBarangay) {
    clearNode(staffBarangay);
    for (const b of items) {
      const option = document.createElement("option");
      option.value = b.id;
      option.textContent = b.name || b.id;
      staffBarangay.appendChild(option);
    }
  }

  return items;
}

async function loadStaff() {
  if (!staffRows) return [];
  const result = await api("/api/owner/staff");
  const items = result.data || [];
  clearNode(staffRows);
  if (!items.length) {
    emptyRow(staffRows, 7, "No staff accounts yet. Add the barangay staff who will process requests.");
    return items;
  }

  for (const s of items) {
    const tr = document.createElement("tr");
    tr.append(
      td(s.id),
      td(s.name),
      td(roleLabel(s.role)),
      td(s.barangayId),
      td(s.username || "-"),
      td(s.psid),
      td(s.active === false ? "Inactive" : "Active")
    );
    staffRows.appendChild(tr);
  }
  return items;
}

function roleLabel(role) {
  const labels = {
    staff: "Staff",
    barangay_admin: "Barangay admin",
    owner: "Owner",
  };
  return labels[role] || role || "-";
}

async function loadAlerts() {
  if (!alertRows) return {};
  const result = await api("/api/owner/token-alerts");
  const entries = Object.entries(result.data || {});
  clearNode(alertRows);
  if (!entries.length) {
    emptyRow(alertRows, 4, "No token alerts. Connected pages look healthy.");
    return result.data || {};
  }

  for (const [barangayId, alert] of entries) {
    const tr = document.createElement("tr");
    tr.append(td(barangayId), td(alert.status), td(alert.message), td(alert.at));
    alertRows.appendChild(tr);
  }
  return result.data || {};
}

function value(id) {
  return document.getElementById(id)?.value.trim() || "";
}

function clearInputs(ids) {
  for (const id of ids) {
    const input = document.getElementById(id);
    if (input) input.value = "";
  }
}

const createBarangayBtn = document.getElementById("createBarangayBtn");
if (createBarangayBtn) {
  createBarangayBtn.addEventListener("click", async () => {
    try {
      createBarangayBtn.disabled = true;
      await api("/api/owner/barangays", {
        method: "POST",
        body: JSON.stringify({
          id: value("brgyId"),
          name: value("brgyName"),
          municipality: value("brgyMunicipality"),
          province: value("brgyProvince"),
          captainName: value("brgyCaptain"),
          secretaryName: value("brgySecretary"),
          pageId: value("brgyPageId"),
          pageAccessToken: value("brgyPageToken"),
          logoUrl: value("brgyLogo"),
        }),
      });
      setMsg("Barangay created.", "success");
      clearInputs(["brgyId", "brgyName", "brgyMunicipality", "brgyProvince", "brgyCaptain", "brgySecretary", "brgyPageId", "brgyPageToken", "brgyLogo"]);
      await loadBarangays();
    } catch (e) {
      setMsg(e.message, "error");
    } finally {
      createBarangayBtn.disabled = false;
    }
  });
}

const createStaffBtn = document.getElementById("createStaffBtn");
if (createStaffBtn) {
  createStaffBtn.addEventListener("click", async () => {
    try {
      createStaffBtn.disabled = true;
      await api("/api/owner/staff", {
        method: "POST",
        body: JSON.stringify({
          id: value("staffId"),
          name: value("staffName"),
          barangayId: staffBarangay?.value,
          role: document.getElementById("staffRole")?.value,
          username: value("staffUsername"),
          password: value("staffPassword"),
          psid: value("staffPsid"),
        }),
      });
      setMsg("Staff member created.", "success");
      clearInputs(["staffId", "staffName", "staffUsername", "staffPassword", "staffPsid"]);
      await loadStaff();
    } catch (e) {
      setMsg(e.message, "error");
    } finally {
      createStaffBtn.disabled = false;
    }
  });
}

function updateSnapshot(barangays, staff, alerts) {
  const alertCount = Object.keys(alerts || {}).length;
  const healthyCount = Math.max(0, barangays.length - alertCount);
  if (ownerSnapshot) {
    ownerSnapshot.textContent = `Barangays: ${barangays.length} | Staff: ${staff.length} | Healthy tokens: ${healthyCount} | Token alerts: ${alertCount}`;
  }
  if (barangayCount) barangayCount.textContent = barangays.length;
  if (staffCount) staffCount.textContent = staff.length;
  if (healthyTokenCount) healthyTokenCount.textContent = healthyCount;
  if (tokenAlertCount) tokenAlertCount.textContent = alertCount;
}

async function init() {
  try {
    setMsg("Loading owner portal...");
    const barangays = await loadBarangays();
    const staff = await loadStaff();
    const alerts = await loadAlerts();
    updateSnapshot(barangays, staff, alerts);
    setMsg("Portal data loaded.", "success");
  } catch (e) {
    setMsg(e.message, "error");
  }
}

init();
