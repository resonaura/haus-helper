import { playbackReady, PLAYBACK_VERSION } from "./playback.mjs";
/** Replication catalog metadata stays bounded even for a five-minute motion burst. */
export function recordingMetadata(event) {
  event = {
    ...event,
    ...(event.playbackVersion === PLAYBACK_VERSION && !playbackReady(event)
      ? { playbackVersion: 0 }
      : {}),
    ...(Number.isFinite(event.mediaStartAt)
      ? { mediaStartAt: Math.round(event.mediaStartAt) }
      : {}),
  };
  return Object.fromEntries(
    [
      "id",
      "cameraId",
      "startAt",
      "endAt",
      "mediaStartAt",
      "duration",
      "originalDuration",
      "kinds",
      "playbackVersion",
    ]
      .filter((key) => event[key] !== undefined)
      .map((key) => [key, event[key]])
      .concat(
        event.playbackInfo
          ? [
              [
                "playbackInfo",
                {
                  audio: event.playbackInfo.audio,
                  originalCompatible: event.playbackInfo.originalCompatible,
                  originalPolicyVersion:
                    event.playbackInfo.originalPolicyVersion,
                  originalProvenance: event.playbackInfo.originalProvenance,
                  compatibilityRepaired:
                    event.playbackInfo.compatibilityRepaired,
                  sourceAudioMissing: event.playbackInfo.sourceAudioMissing,
                  largestGap: event.playbackInfo.largestGap,
                  duration: event.playbackInfo.duration,
                  audioTailSeconds: event.playbackInfo.audioTailSeconds,
                  audioTrimSeconds: event.playbackInfo.audioTrimSeconds,
                },
              ],
            ]
          : [],
      ),
  );
}
