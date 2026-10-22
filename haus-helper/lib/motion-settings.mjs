// Includes inference and cluster polling; retain matching pre-event ring media.
export const MAX_ASSIST_DELAY_MS = 30_000;

export function motionSettings(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !["enabled", "mode"].includes(key)) ||
    typeof value.enabled !== "boolean" ||
    !["objects", "motion"].includes(value.mode)
  )
    throw new Error("invalid_motion_detection");
  return { enabled: value.enabled, mode: value.mode };
}
