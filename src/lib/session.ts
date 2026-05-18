import { Storage } from 'megajs';

const STORAGE_KEY = 'megastream:session';

export async function loginWithCredentials(email: string, password: string): Promise<Storage> {
  const storage = new Storage({ email, password });
  await storage.ready;
  saveSession(storage);
  return storage;
}

export function saveSession(storage: Storage) {
  try {
    const json = storage.toJSON();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(json));
  } catch (err) {
    console.warn('Failed to save session', err);
  }
}

export function hasSavedSession(): boolean {
  try {
    return !!localStorage.getItem(STORAGE_KEY);
  } catch (_) {
    return false;
  }
}

export async function restoreSession(): Promise<Storage | null> {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch (_) {}
  if (!raw) return null;
  try {
    const json = JSON.parse(raw);
    const storage = Storage.fromJSON(json);
    await storage.reload(true);
    return storage;
  } catch (err) {
    console.warn('Restoring session failed:', err);
    clearSession();
    return null;
  }
}

export function clearSession() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (_) {}
}
