export const SERVER_DRAFT_SESSION_STORAGE_KEY = "phase-server-draft-session";
export const SERVER_DRAFT_SESSION_TTL_MS = 2 * 60 * 60 * 1000;

export interface ServerDraftSessionData {
  draftCode: string;
  playerToken: string;
  serverUrl: string;
  seatIndex: number | null;
  timestamp: number;
}

export function isServerDraftSessionValid(
  session: ServerDraftSessionData,
): boolean {
  return Date.now() - (session.timestamp ?? 0) < SERVER_DRAFT_SESSION_TTL_MS;
}

export function loadServerDraftSession(): ServerDraftSessionData | null {
  const raw = localStorage.getItem(SERVER_DRAFT_SESSION_STORAGE_KEY);
  if (!raw) return null;

  try {
    const session = JSON.parse(raw) as ServerDraftSessionData;
    if (!isServerDraftSessionValid(session)) {
      clearServerDraftSession();
      return null;
    }
    return session;
  } catch {
    clearServerDraftSession();
    return null;
  }
}

export function saveServerDraftSession(
  session: ServerDraftSessionData,
): void {
  localStorage.setItem(
    SERVER_DRAFT_SESSION_STORAGE_KEY,
    JSON.stringify(session),
  );
}

export function clearServerDraftSession(): void {
  localStorage.removeItem(SERVER_DRAFT_SESSION_STORAGE_KEY);
}
