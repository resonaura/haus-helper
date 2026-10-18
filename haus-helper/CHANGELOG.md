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
