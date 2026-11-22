/**
 * Who the server's low-GPU voice profile is on for (its lighter models
 * read the replies), as GET /api/voice last said (voiceChat.ts
 * fetchVoiceAvailability): null when the full models read them. The call
 * bar shows it.
 */
let light: string | null = null;
const listeners = new Set<() => void>();

export function voiceLight(): string | null {
  return light;
}

export function setVoiceLight(reason: string | null) {
  if (light === reason) return;
  light = reason;
  for (const listener of [...listeners]) listener();
}

export function subscribeVoiceLight(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
