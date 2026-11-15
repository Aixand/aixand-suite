/** Package inclusion, independent of worker or model readiness. */
export function voiceEnabled() {
  return process.env.AIXAND_VOICE_ENABLED === '1' ||
    (process.env.AIXAND_VOICE_ENABLED === undefined && process.env.AIXAND_PACKAGED_RUNTIME !== '1');
}
