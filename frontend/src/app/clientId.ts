export function createClientId(prefix = "client"): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (uuid) return `${prefix}:${uuid}`;

  const random = Math.random().toString(36).slice(2);
  return `${prefix}:${Date.now().toString(36)}:${random}`;
}
