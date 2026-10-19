# 0.3.0

- Add per-camera software motion recording, disabled by default. Smart mode uses local NanoDet object recognition; sustained-motion mode handles small animals and other movement with temporal/noise/exposure filtering.
- Prefer compatible NVR workers, distribute by quota, expire lost capabilities and reassign failed or persistently overloaded jobs. Keep at most one resource-aware local fallback and never accumulate an inference backlog.
- Preserve the existing continuous pre-event ring and post-activity tail independently of analysis. Normalize first-frame timestamps and bound replicated metadata even for long detection bursts.

# 0.2.10

- Keep motion pre-roll aligned to local receipt times even when a camera's RTP timestamps drift. Preserve the first frame's actual time, including eight seconds of pre-event footage by default.
- Watch completed segments as well as frame counters, restarting an ingest that is alive but no longer produces footage.
- Query playable moments separately from failed capture attempts so failures cannot bury older recordings in the viewer.
- Balance optional relays by each node's available capacity and avoid overloaded workers.

# 0.2.9

- Use RTSP's protocol-specific TCP I/O timeout for direct capture and discovery. Real Debian FFmpeg rejected the HTTP timeout option even though the macOS fixture accepted it; HA fallback preserved video during the check.

# 0.2.8

- Prefer explicitly associated local RTSP telemetry for recording. This bypasses an observed HA HLS session that advertised AAC but delivered no audio packets, while the same camera's direct stream contained sound.
- Use TCP for direct capture, keep HA credentials out of camera requests and public camera metadata, and fall back to authenticated HA HLS after repeated source failures. Source selection is exact/device-based and rejects ambiguous or non-local telemetry.

# 0.2.7

- Probe authenticated HLS audio before selecting recording tracks, allow longer audio discovery, and require the advertised track so an audio-capable source cannot silently start a video-only buffer. Probes cancel when recording stops; sources without audio still retain their video.

# 0.2.6

- Allow authenticated, seekable reads of original recordings for integrity and source timing/audio audits without compatibility encoding or changing the source files. Normal app playback still uses prepared compatible media.

# 0.2.5

- Reconnect when recorder frame progress stalls and forcibly reap encoders that ignore shutdown.
- Reuse healthy recording buffers for preview preheat; never wake battery cameras for dashboard previews.
- Reacquire failed HLS sources and restart lost NVR relays while keeping leases and work bounded.
- Preserve and report actual recorded audio through finalization; validate real H264/AAC output.

# 0.2.4

- Page camera recordings in both directions across days without repeating clips, including equal timestamps.
- Provide indexed calendar-day markers using device-local date boundaries, including daylight-saving transitions.

# 0.2.3

- Create full HA archives as background jobs and wait for the exact named backup through read-only status queries. Accept asynchronous and empty accepted responses without starting duplicate archives.

# 0.2.2

- Back off failed automatic backups for 5–60 minutes and retain that cooldown across restarts. Explicit retries remain available; successful backups clear the failure state.

# 0.2.1

- Discover Eufy using read-only info endpoints permitted to the existing backup role; avoid requiring manager access.

# 0.2.0

- Bounded camera-stream warming and optional NVR live relays with opaque, expiring camera capabilities.
- Optional NVR storage/media workers, verified replication, direct seekable playback grants and recovery catalogs.
- Helper-backed shared layout with revision checks, home-scoped offline caches, and private native recovery-kit export.
- Encrypted configuration/HA backup rings and consistent SQLite hot-backup hooks; exclude recursive archives and media buffers.
- Eufy Security WebSocket talkback with confirmed startup and owned-session cleanup; streaming ingress for microphone POST bodies.
- Fixed-cadence versioned playback copies, explicit concat durations, source-gap diagnostics and a bounded priority encoder queue.

## 0.1.9

- Validate numeric private addresses before accepting a Talkback RTMP target, rejecting external DNS names that resemble private IPv4 prefixes.

## 0.1.8

- Add authenticated microphone streaming for cameras with a dedicated local Talkback RTMP sensor.
- Transcode browser Opus to mono AAC using the existing FFmpeg runtime; stop on disconnect, timeout or client cancellation.
- Keep camera addresses inside the add-on; the client receives only talkback availability.
- Update the Haus icon with platform spacing and a neutral glass treatment.

## 0.1.7

- Normalize saved video for reliable hardware decoding in macOS and desktop players.
- Prepare compatible copies of older recordings on first use while preserving originals; include copies in retention and disk limits.

## 0.1.6

- Persist observed camera availability for offline bands in the Haus video timeline. Gaps while Haus or the server is disconnected remain unknown.

## 0.1.5

- Give every video segment a unique session and sequence identity, use media timestamps for clip selection, and deduplicate manifests to prevent repeated footage.

## 0.1.4

- Pace buffered HLS input in real time and start at the newest segment to preserve pre-roll without filename collisions.

## 0.1.3

- Fix camera buffer process startup and verify authenticated HLS ingestion with real FFmpeg.

# 0.1.2

- Continue long activity across bounded clips without fabricating detection events.
- Respect paused cameras immediately and include all active detectors on reconnect.

# 0.1.1

- Reuse public camera streams while inheriting internal camera detectors.
- Avoid duplicate buffers for Generic camera wrappers.
- Recover ongoing detector activity after reconnection.

# 0.1.0

- Automatic camera and event detector discovery with manual overrides.
- Local pre-roll buffer and event-based MP4 recordings.
- Motion, person, pet, vehicle and doorbell event labels.
- Camera timeline with authenticated seeking and download.
- Local retention and storage limits.
- Home Assistant Ingress and native Haus integration.
