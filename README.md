# Haus

Private home server and camera companion services for [Haus](https://github.com/resonaura/haus). This repository is `haus-helper`; the Home Assistant app is named **Haus**.

Haus discovers cameras and their motion, person, pet, vehicle and doorbell detectors. A short local ring buffer preserves the beginning of an event; relevant video is finalized into a seekable MP4, indexed in SQLite, and shown in a timeline in Haus or the app's Home Assistant interface. Recordings remain on your home server. There is no cloud video service.

## Install

Add `https://github.com/resonaura/haus-helper` to **Settings → Apps → App store → Repositories**, install **Haus**, and start it. On earlier Home Assistant versions these pages are named **Add-ons**. Open its web interface, or open a camera in the Haus desktop app.

Container images are built by GitHub Actions for `amd64` and `aarch64`. The app uses Home Assistant's authenticated Ingress; it does not publish a network port, use the host network, or require a new password. `homeassistant_api` lets it discover entities and obtain camera streams with the Supervisor-provided credential. The credential never enters the browser or recordings database.

## Recording

- Related entities on the same registered device are linked automatically. A unique matching camera name can link an external detector. A shared room alone is insufficient; ambiguous matches remain suggestions.
- Choose **Detectors & recording** to disable a camera or explicitly choose its detectors. An empty manual selection disables automatic event capture for that camera; **Record now** remains available.
- Motion and object activity share an event. New detections extend the tail up to the configured event limit. Events show their original detector types and timestamps.
- Defaults: 8 seconds of pre-roll, 20 seconds after activity, 5 minutes maximum per event, 7 days of retention, a 10 GiB local recent-video cache and 1 GiB for temporary buffers. These limits are configurable through the Home Assistant app options. Existing saved budgets are preserved.
- Buffers use stream copy. Healthy indexed H264/AAC clips with continuous packet timing, bounded keyframes and validated capture provenance play directly without a new encode. The first proven camera profile is Eufy Security T8410C at 1080p High 4.2 with no B-frames; camera/room names never confer trust. Unknown originals and Aqara bitstreams require a compatibility copy, because clean packet timing alone does not establish VideoToolbox compatibility. Unsupported or irregular media keeps a separate compatibility copy; originals remain untouched. New clips request idle NVR preparation immediately, including a just-in-time upload when periodic replication has not happened yet. Temporary uploaded originals are pinned during decoder work, tracked for cleanup and can be adopted as regular recovery replicas. A bounded pending page continues preparation beyond the latest two recordings. Encoders remain bounded and weak or busy workers are excluded. Audio is controlled by the app's `record_audio` option.
- A camera must expose a working HLS stream through Home Assistant. Snapshot-only cameras cannot produce recordings. Actual pre-roll depends on the available buffered stream; camera or server outages can produce partial recordings, which are identified in the event metadata. Timestamps describe ingestion into the local buffer, not a camera's hardware clock.

Completed MP4s and thumbnails live in `/media/haus`. The database and temporary buffers live in the app's `/data`. Retention only cleans Haus-owned files. Existing media outside these directories is untouched. Shutdown or failed finalization leaves an explicit event status rather than an empty playable recording.

## Home servers

Haus Helper 0.3.44 supports monitoring-only server connections with no storage or stream role. The desktop can attach one to an existing SSH device so terminal access and telemetry share the same card and room. Optional SSH associations contain only a device identity; SSH credentials remain on the desktop. Monitoring-only connections receive no recordings, playback preparation or recovery copies. Use the monitoring Compose setup in the [server agent repository](https://github.com/resonaura/haus-nvr/blob/main/docs/server-management.md).

Haus has an authenticated `GET /api/servers` inventory for the Home Assistant primary and all registered NVR servers. A server reports its CPU, memory, swap, disk/volume layout and available Docker/PM2 inventory. Missing capabilities remain explicitly unavailable. Linux host CPU/memory use kernel-wide `/proc` counters; Home Assistant OS and physical disks come from Supervisor. Core and app container usage is listed separately and is never presented as host usage. The Supervisor Docker view covers managed Home Assistant containers; it does not pretend to inventory unrelated host containers. PM2 needs a host collector on a remote node.

The app uses the Supervisor `manager` role to read host disks, installed app inventory and per-container statistics. Haus exposes only fixed read endpoints for that telemetry, never a generic Supervisor proxy or Docker socket. Samples are cached for five seconds, coalesced across clients, and have a 2.5-second collection deadline; slow or unsupported sources leave nullable metrics.

The Home Assistant recent-video cache defaults to 10 GiB on new installs. NVR storage defaults to unlimited; `max_storage_gb: 0` or a saved `storageLimitBytes: null` removes a user size cap, while a free-space reserve still protects the disk. Existing configuration and saved user policies are preserved. Administrators can set a precise persisted local cache budget with `PATCH /api/servers/home-assistant` and `{ "storageLimitBytes": number | null }`. Remote policies use `PATCH /api/cluster/nodes/:id` with the same field; `enabled` is an independent optional field. Remote policy writes are authenticated and acknowledged before helper metadata changes. Configuration, preferences and recovery backups keep their separate policies.

At the local budget, Haus rotates the oldest completed, playable footage only after one healthy storage node has both its unchanged original and its current compatibility copy, when required. The NVR hashes its actual persisted bytes before accepting an archive and again immediately before local eviction. Old or unsupported workers, unprepared media, failed hashes and offline/full nodes cannot authorize eviction. Catalog entries, thumbnails, NVR footage, backups and pre-event buffers remain intact. Historical original and playback requests, including byte ranges, are served through authenticated storage nodes after local rotation; a storage-only node can serve them too.

Verified old copies rotate slightly before the local cache reaches its cap, leaving capture headroom of up to 512 MiB (10% for smaller budgets). The saved user limit stays unchanged. If no verified archive can safely receive the footage, a full local cache pauses new events while an in-flight recording finishes. Raising/removing the cap resumes admission. Active playback, preparation and finalization hold leases against local rotation and age deletion. Node budgets pause new copies without evicting existing data. The separately configured age retention still removes expired Haus recordings on both tiers. The server inventory reports local, archived and temporarily unavailable bytes separately, rather than counting all history against the HA cache.

Compatibility preparation supports short async polling (`X-Haus-Async-Prepare: 1`). A decoder retry can request a separate repair copy with authenticated `POST /api/events/:id/repair` and an empty JSON object. Repeat that POST to poll the coalesced job: `202` means preparation is running (`retryAfterMs: 1000`), and `200` returns the updated event. The API advertises `features.recordingRepair` and `features.verifiedOriginalPlayback`. This bypasses the original fast path without overwriting its source. First access to an old incompatible recording may still need processing; this is exposed rather than serving unchecked media as if it were repaired.

## Development

Requires Node 24+ and FFmpeg.

```sh
cd haus-helper
npm ci
npm test
```

Tests include automatic detector association, event merging, storage limits and retention, authenticated media byte-range seeking, and actual FFmpeg finalization of synthetic video.

For standalone API development, set `HAUS_STANDALONE=1`, `HAUS_API_TOKEN`, `HAUS_HA_URL`, `HAUS_HA_TOKEN`, `HAUS_DATA`, and `HAUS_MEDIA`. Standalone API requests require a bearer token; the ordinary web UI is intended for authenticated Home Assistant Ingress. Never commit these environment values.

The API is versioned by the application release and keeps service modules separate from the camera recorder so future local Haus services can be added without changing the recording model.

### Managed Haus storage measurements

Server `storage.usage` exposes cached, background file accounting across managed data and media roots. It does not scan unrelated Home Assistant files, container images or external runtime logs. Logical file size and filesystem-reported allocated blocks are separate; hard links count once, cross-category sharing is explicit, and unknown allocation stays null. Bounded or unreadable scans are partial lower bounds. Allocated blocks may still share physical extents through compression, snapshots or reflinks.

NVR originals/prepared roles come from authoritative archive digests. Older node catalogs are repaired in small resumable metadata-only batches after they support usage version 1; this never reuploads, deletes or normalizes media. The first sample may be unavailable, then updates at most every 30 seconds independently of CPU/RAM sampling.

### Unified camera activity

Haus publishes one Activity motion sensor per discovered camera through Home Assistant's existing MQTT publish service, when MQTT is configured. Discovery is retained; observations are not retained and expire after 45 seconds without a live publisher. No broker credentials are copied into Haus. The original integration entities and existing automations are preserved. Exact camera-native and matching Matter projections are identified in attributes so Haus can show one canonical activity tile, while independent PIR sensors remain separate devices.

With Activity Assist off, native linked detections retain their behavior. With Assist on and fresh, generic motion is validated by local analysis; native classified person/pet/vehicle and doorbell events still qualify. After a bounded 30-second analysis-start/recovery window, unavailable analysis explicitly falls back to available native detectors, rather than claiming the scene is clear. The state reports `native_fallback` so clients can explain the reduced filtering. Without either a live detector or fresh analysis, activity is unavailable. A short hold and recording coalescing prevent two sources from producing duplicate clips. Pre-event recording continues through the existing warm NVR ring.

Object mode confirms overlapping detections across distinct frames after foreground gating. Sustained-movement mode rejects brief noise, exposure changes and small local oscillation, but cannot guarantee rejection of all moving vegetation. NVR assignments honor measured load, reserved detector slots and weak-node budgets; the existing bounded HA fallback remains explicit. New cameras remain stream-only and Assist stays off by default.


The camera relationship also lives in the MQTT device registry: Home Assistant deliberately removes runtime extra attributes while an entity is unavailable. Haus uses that persistent identity and home-scoped helper metadata to keep offline activity attached to its camera and avoid reviving native duplicate cards. Name-only HA motion groups cannot bypass Assist validation; an independently registered physical detector is distinguished from a camera-native projection.


Assist placement also compares measured host CPU and yields to the node’s separate analysis-pressure signal. A fresh decoded frame is not a clear reading until foreground calibration completes; local fallback uses the same readiness rule. The recovery grace allows calibration on slower processors before explicit native fallback.
