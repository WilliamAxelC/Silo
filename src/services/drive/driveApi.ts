import * as FileSystem from 'expo-file-system/legacy';

/**
 * Minimal Google Drive v3 client for Silo's own folder (drive.file scope). Every call takes the access
 * token explicitly so nothing here stores credentials.
 */
const API = 'https://www.googleapis.com/drive/v3';
const UPLOAD = 'https://www.googleapis.com/upload/drive/v3/files';
export const FOLDER_MIME = 'application/vnd.google-apps.folder';

export interface DriveFile {
  id: string;
  name: string;
  size?: number;
  createdTime?: string;
}

type FetchLike = typeof fetch;
let fetchImpl: FetchLike = (...args) => fetch(...args);

export class DriveError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
  }
}

async function call<T>(token: string, url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) } });
  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.json())?.error?.message ?? '';
    } catch {
      // no JSON body
    }
    throw new DriveError(`Google Drive error ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

const q = (s: string) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

/** Finds (or creates) a folder Silo made, by name under a parent ('root' for the top level). */
export async function ensureFolder(token: string, name: string, parentId = 'root'): Promise<string> {
  const query = `name = '${q(name)}' and mimeType = '${FOLDER_MIME}' and '${q(parentId)}' in parents and trashed = false`;
  const found = await call<{ files: DriveFile[] }>(token, `${API}/files?q=${encodeURIComponent(query)}&fields=files(id,name)&spaces=drive`);
  if (found.files?.[0]?.id) return found.files[0].id;
  const created = await call<DriveFile>(token, `${API}/files?fields=id`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }),
  });
  return created.id;
}

export async function listFiles(token: string, parentId: string): Promise<DriveFile[]> {
  const query = `'${q(parentId)}' in parents and trashed = false and mimeType != '${FOLDER_MIME}'`;
  const out: DriveFile[] = [];
  let pageToken = '';
  do {
    const page = await call<{ files: Array<DriveFile & { size?: string }>; nextPageToken?: string }>(
      token,
      `${API}/files?q=${encodeURIComponent(query)}&orderBy=createdTime desc&pageSize=200&fields=nextPageToken,files(id,name,size,createdTime)${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`,
    );
    for (const f of page.files ?? []) out.push({ ...f, size: f.size != null ? Number(f.size) : undefined });
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return out;
}

/** Resumable upload: the file streams from disk, so large backups never load into memory. */
export async function uploadFile(token: string, localUri: string, name: string, parentId: string, mimeType: string): Promise<string> {
  const start = await fetchImpl(`${UPLOAD}?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'X-Upload-Content-Type': mimeType,
    },
    body: JSON.stringify({ name, parents: [parentId] }),
  });
  const session = start.headers.get('location') ?? start.headers.get('Location');
  if (!start.ok || !session) throw new DriveError(`Google Drive refused the upload (${start.status}).`, start.status);
  const res = await FileSystem.uploadAsync(session, localUri, {
    httpMethod: 'PUT',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': mimeType },
  });
  if (res.status < 200 || res.status >= 300) throw new DriveError(`Upload to Google Drive failed (${res.status}).`, res.status);
  const id = JSON.parse(res.body || '{}')?.id;
  if (!id) throw new DriveError('Google Drive did not confirm the upload.');
  return id;
}

export async function downloadFile(token: string, fileId: string, localUri: string): Promise<string> {
  const res = await FileSystem.downloadAsync(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, localUri, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status !== 200) {
    await FileSystem.deleteAsync(localUri, { idempotent: true }).catch(() => undefined);
    throw new DriveError(`Download from Google Drive failed (${res.status}).`, res.status);
  }
  return res.uri;
}

export async function deleteFile(token: string, fileId: string): Promise<void> {
  await call<void>(token, `${API}/files/${encodeURIComponent(fileId)}`, { method: 'DELETE' });
}

/** For tests. */
export function __setDriveFetchForTests(impl: FetchLike) {
  fetchImpl = impl;
}
