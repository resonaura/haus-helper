const $ = (id) => document.getElementById(id);
const escape = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let cameras = [];
let detectors = [];
let events = [];
let selected = "all";
let filter = "all";
let cursor = null;
let settingsCamera;
let revision = 0;
let loading = false;
const localDate = (date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
$("day").value = localDate(new Date());
const kindNames = {
  motion: "Motion",
  person: "Person",
  pet: "Pet",
  vehicle: "Vehicle",
  doorbell: "Doorbell",
  manual: "Manual",
};
const cameraName = (id) =>
  cameras.find((camera) => camera.id === id)?.name ?? id;
const time = (at) =>
  new Date(at).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
const bytes = (value) =>
  value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(value / 1024 ** 2)} MB`;
async function api(path, method = "GET", data) {
  const response = await fetch(path, {
    method,
    headers: {
      "X-Haus-Client": "1",
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    body: data ? JSON.stringify(data) : undefined,
    cache: "no-store",
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Request failed");
  return result;
}
function error(reason) {
  $("error").textContent = String(reason.message || reason).replaceAll(
    "_",
    " ",
  );
  $("error").hidden = false;
}
function loadImages(container) {
  for (const image of container.querySelectorAll("img")) {
    image.onload = () => image.classList.add("ready");
    if (image.complete && image.naturalWidth) image.classList.add("ready");
  }
}
function renderCameras() {
  const buffers = new Map(
    (window.hausStatus?.buffers ?? []).map((buffer) => [
      buffer.cameraId,
      buffer,
    ]),
  );
  $("camera-count").textContent =
    `${cameras.length} ${cameras.length === 1 ? "camera" : "cameras"}`;
  $("cameras").innerHTML = cameras
    .map((camera) => {
      const state = !camera.enabled
        ? "Recording paused"
        : !camera.available
          ? "Unavailable"
          : buffers.get(camera.id)?.status === "buffering"
            ? camera.sensors.length
              ? `${camera.sensors.length} event detectors`
              : "Manual recordings"
            : buffers.get(camera.id)?.error || "Connecting stream";
      return `<article class="camera ${selected === camera.id ? "selected" : ""}"><button class="camera-select" data-select="${escape(camera.id)}"><div class="camera-preview"><img src="api/cameras/${encodeURIComponent(camera.id)}/snapshot" alt="${escape(camera.name)}" loading="lazy" decoding="async"></div><div class="camera-body"><span><strong>${escape(camera.name)}</strong><small>${escape(state)}</small></span><span aria-hidden>↗</span></div></button><div class="camera-actions"><button data-configure="${escape(camera.id)}">Detectors & recording</button><button data-record="${escape(camera.id)}" ${!camera.enabled || !camera.available ? "disabled" : ""}>Record now</button></div></article>`;
    })
    .join("");
  if (!cameras.length)
    $("cameras").innerHTML =
      '<div class="empty"><strong>Looking for your cameras</strong><p>Cameras appear here after the home connection is ready.</p></div>';
  loadImages($("cameras"));
}
function renderFilters() {
  const items = [["all", "All events"], ...Object.entries(kindNames)];
  $("filters").innerHTML =
    `<button data-camera="all" aria-pressed="${selected === "all"}">Every camera</button>` +
    items
      .map(
        ([id, name]) =>
          `<button data-filter="${id}" aria-pressed="${filter === id}">${name}</button>`,
      )
      .join("");
}
function renderEvents() {
  const signature = events
    .map((event) => `${event.id}:${event.status}:${event.bytes}`)
    .join("|");
  if ($("events").dataset.signature === signature && signature) return;
  $("events").dataset.signature = signature;
  $("event-caption").textContent =
    selected === "all"
      ? "Choose a moment to look closer."
      : cameraName(selected);
  $("events").innerHTML = events.length
    ? events
        .map(
          (event) =>
            `<button class="event" data-play="${escape(event.id)}" ${event.status !== "ready" ? "disabled" : ""}><div class="event-image">${event.thumbnailUrl ? `<img src="${escape(event.thumbnailUrl)}" alt="" loading="lazy" decoding="async">` : ""}<span class="event-kind">${escape(event.kinds.map((kind) => kindNames[kind] ?? kind).join(" · "))}</span></div><div class="event-body"><span><strong>${escape(cameraName(event.cameraId))}</strong><small>${escape(time(event.startAt))}</small></span><span class="event-duration">${event.status === "ready" ? `${Math.round(event.duration)}s` : event.status === "recording" ? "Recording…" : event.status === "interrupted" ? "Interrupted" : "Unavailable"}</span></div></button>`,
        )
        .join("")
    : '<div class="empty"><strong>A quiet moment.</strong><p>No recordings match this day and filter. New activity will appear here automatically.</p></div>';
  $("more").hidden = !cursor;
  loadImages($("events"));
}
async function refreshEvents(append = false) {
  const generation = ++revision;
  const from = new Date(`${$("day").value}T00:00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  const query = new URLSearchParams({
    from: String(from.getTime()),
    to: String(to.getTime() - 1),
    limit: "60",
  });
  if (selected !== "all") query.set("camera_id", selected);
  if (filter !== "all") query.set("kind", filter);
  if (append && cursor) query.set("cursor", cursor);
  const result = await api(`api/events?${query}`);
  if (generation !== revision) return;
  events = append ? [...events, ...result.events] : result.events;
  cursor = result.nextCursor;
  renderEvents();
}
async function refresh(initial = false) {
  if (loading || document.visibilityState !== "visible") return;
  loading = true;
  try {
    const [status, result] = await Promise.all([
      api("api/status"),
      api("api/cameras"),
    ]);
    window.hausStatus = status;
    $("connection").textContent = status.connected
      ? status.recordingEnabled
        ? "Recording locally"
        : "Recording paused"
      : "Home is reconnecting";
    $("storage").innerHTML =
      `<b>${bytes(status.storage.bytes)} <span>of ${bytes(status.storage.maxBytes)}</span></b>${status.storage.count} saved moments`;
    $("retention").textContent =
      `Stored locally · ${status.storage.retentionDays}-day retention`;
    const changed = JSON.stringify(cameras) !== JSON.stringify(result.cameras);
    cameras = result.cameras;
    if (changed || initial) renderCameras();
    await refreshEvents();
    $("error").hidden = true;
  } catch (reason) {
    error(reason);
  } finally {
    loading = false;
  }
}
async function configure(id) {
  settingsCamera = cameras.find((camera) => camera.id === id);
  if (!settingsCamera) return;
  try {
    detectors = (await api("api/detectors")).detectors;
    $("settings-title").textContent = settingsCamera.name;
    $("record-enabled").checked = settingsCamera.enabled;
    $("auto-sensors").checked = settingsCamera.sensorMode !== "manual";
    const chosen = new Set(settingsCamera.sensors.map((sensor) => sensor.id));
    $("detectors").innerHTML =
      "<legend>Event detectors</legend>" +
      detectors
        .map(
          (sensor) =>
            `<label><input type="checkbox" value="${escape(sensor.id)}" ${chosen.has(sensor.id) ? "checked" : ""}><span>${escape(sensor.name)}<small>${escape(kindNames[sensor.kind] ?? sensor.kind)}</small></span></label>`,
        )
        .join("");
    if (!detectors.length)
      $("detectors").innerHTML +=
        "<p>No motion or object detectors are currently available. Manual recording still works.</p>";
    updateDetectorState();
    $("settings-error").hidden = true;
    $("settings").showModal();
  } catch (reason) {
    error(reason);
  }
}
function updateDetectorState() {
  for (const input of $("detectors").querySelectorAll("input"))
    input.disabled = $("auto-sensors").checked;
}
$("auto-sensors").addEventListener("change", updateDetectorState);
$("save-settings").onclick = async () => {
  const button = $("save-settings");
  button.disabled = true;
  try {
    await api(`api/cameras/${settingsCamera.id}`, "PATCH", {
      enabled: $("record-enabled").checked,
      sensorIds: $("auto-sensors").checked
        ? null
        : [...$("detectors").querySelectorAll("input:checked")].map(
            (input) => input.value,
          ),
    });
    $("settings").close();
    await refresh(true);
  } catch (reason) {
    $("settings-error").textContent = String(reason.message).replaceAll(
      "_",
      " ",
    );
    $("settings-error").hidden = false;
  } finally {
    button.disabled = false;
  }
};
$("cameras").onclick = async (event) => {
  const configureButton = event.target.closest("[data-configure]");
  if (configureButton) return void configure(configureButton.dataset.configure);
  const record = event.target.closest("[data-record]");
  if (record) {
    record.disabled = true;
    try {
      await api(`api/cameras/${record.dataset.record}/record`, "POST", {});
      record.textContent = "Recording…";
      await refreshEvents();
    } catch (reason) {
      error(reason);
    } finally {
      record.disabled = false;
    }
    return;
  }
  const select = event.target.closest("[data-select]");
  if (select) {
    selected =
      selected === select.dataset.select ? "all" : select.dataset.select;
    renderCameras();
    renderFilters();
    void refreshEvents().catch(error);
  }
};
$("filters").onclick = (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.filter) filter = button.dataset.filter;
  if (button.dataset.camera) selected = button.dataset.camera;
  renderFilters();
  renderCameras();
  void refreshEvents().catch(error);
};
$("events").onclick = (event) => {
  const button = event.target.closest("[data-play]");
  if (!button) return;
  const clip = events.find((item) => item.id === button.dataset.play);
  if (!clip?.videoUrl) return;
  $("clip-title").textContent = cameraName(clip.cameraId);
  $("clip-time").textContent =
    `${new Date(clip.startAt).toLocaleString()} · ${clip.kinds.map((kind) => kindNames[kind] ?? kind).join(", ")}`;
  $("video").src = clip.videoUrl;
  $("download").href = clip.videoUrl;
  $("download").download = `haus-${clip.id}.mp4`;
  $("playback").hidden = false;
  $("play-error").hidden = true;
  void $("video")
    .play()
    .catch(() => {});
  $("playback").scrollIntoView({
    behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
      ? "instant"
      : "smooth",
    block: "nearest",
  });
};
$("video").onerror = () => {
  $("play-error").hidden = false;
};
$("close-player").onclick = () => {
  $("video").pause();
  $("video").removeAttribute("src");
  $("video").load();
  $("playback").hidden = true;
};
$("day").onchange = () => void refreshEvents().catch(error);
$("more").onclick = () => void refreshEvents(true).catch(error);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refresh();
});
renderFilters();
void refresh(true);
setInterval(() => void refresh(), 8000);
