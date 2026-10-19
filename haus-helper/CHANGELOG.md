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
