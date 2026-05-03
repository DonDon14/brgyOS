const ownerKeyInput = document.getElementById("ownerKey");
const saveKeyBtn = document.getElementById("saveKeyBtn");
const msg = document.getElementById("msg");
const barangayRows = document.getElementById("barangayRows");
const staffRows = document.getElementById("staffRows");
const alertRows = document.getElementById("alertRows");
const staffBarangay = document.getElementById("staffBarangay");

ownerKeyInput.value = localStorage.getItem("brgyos_owner_key") || "";
saveKeyBtn.addEventListener("click", () => {
  localStorage.setItem("brgyos_owner_key", ownerKeyInput.value.trim());
  msg.textContent = "Owner key saved.";
  init();
});

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

async function loadBarangays() {
  const result = await api("/api/owner/barangays");
  const items = result.data || [];
  barangayRows.innerHTML = items
    .map(
      (b) =>
        `<tr><td>${b.id}</td><td>${b.name || "-"}</td><td>${b.municipality || "-"}, ${
          b.province || "-"
        }</td><td>${b.captainName || "-"}</td><td>${b.secretaryName || "-"}</td><td>${b.pageId || "-"}</td></tr>`
    )
    .join("");
  staffBarangay.innerHTML = items.map((b) => `<option value="${b.id}">${b.name || b.id}</option>`).join("");
}

async function loadStaff() {
  const result = await api("/api/owner/staff");
  const items = result.data || [];
  staffRows.innerHTML = items
    .map(
      (s) =>
        `<tr><td>${s.id}</td><td>${s.name || "-"}</td><td>${s.role || "-"}</td><td>${
          s.barangayId || "-"
        }</td><td>${s.psid || "-"}</td><td>${s.active === false ? "No" : "Yes"}</td></tr>`
    )
    .join("");
}

async function loadAlerts() {
  const result = await api("/api/owner/token-alerts");
  const entries = Object.entries(result.data || {});
  alertRows.innerHTML = entries
    .map(
      ([barangayId, a]) =>
        `<tr><td>${barangayId}</td><td>${a.status || "-"}</td><td>${a.message || "-"}</td><td>${a.at || "-"}</td></tr>`
    )
    .join("");
}

document.getElementById("createBarangayBtn").addEventListener("click", async () => {
  try {
    await api("/api/owner/barangays", {
      method: "POST",
      body: JSON.stringify({
        id: document.getElementById("brgyId").value.trim(),
        name: document.getElementById("brgyName").value.trim(),
        municipality: document.getElementById("brgyMunicipality").value.trim(),
        province: document.getElementById("brgyProvince").value.trim(),
        captainName: document.getElementById("brgyCaptain").value.trim(),
        secretaryName: document.getElementById("brgySecretary").value.trim(),
        pageId: document.getElementById("brgyPageId").value.trim(),
        pageAccessToken: document.getElementById("brgyPageToken").value.trim(),
        logoUrl: document.getElementById("brgyLogo").value.trim(),
      }),
    });
    msg.textContent = "Barangay created.";
    await init();
  } catch (e) {
    msg.textContent = e.message;
  }
});

document.getElementById("createStaffBtn").addEventListener("click", async () => {
  try {
    await api("/api/owner/staff", {
      method: "POST",
      body: JSON.stringify({
        id: document.getElementById("staffId").value.trim(),
        name: document.getElementById("staffName").value.trim(),
        barangayId: staffBarangay.value,
        role: document.getElementById("staffRole").value,
        psid: document.getElementById("staffPsid").value.trim(),
      }),
    });
    msg.textContent = "Staff created.";
    await init();
  } catch (e) {
    msg.textContent = e.message;
  }
});

async function init() {
  try {
    await loadBarangays();
    await loadStaff();
    await loadAlerts();
  } catch (e) {
    msg.textContent = e.message;
  }
}

init();
