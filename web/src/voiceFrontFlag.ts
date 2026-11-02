/**
 * Whether the server has a voice front (voice.json front_model), as GET
 * /api/voice last said (voiceChat.ts fetchVoiceAvailability). Kept apart
 * so the app's menus, shortcuts and the companion's chip can ask without
 * loading voice chat.
 */
let fronting = false;
const listeners = new Set<() => void>();

export function voiceFronting(): boolean {
  return fronting;
}

export function setVoiceFronting(on: boolean) {
  if (fronting === on) return;
  fronting = on;
  for (const listener of [...listeners]) listener();
}

export function subscribeVoiceFronting(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
