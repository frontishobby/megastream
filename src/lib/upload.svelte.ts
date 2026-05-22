import type { MutableFile } from 'megajs';

export type UploadStatus = 'queued' | 'uploading' | 'done' | 'error' | 'cancelled';

export interface UploadJob {
  id: string;
  name: string;
  size: number;
  uploaded: number;
  status: UploadStatus;
  error?: string;
  folderId: string;
}

const MAX_CONCURRENT = 3;
const AUTO_REMOVE_DONE_MS = 2500;

let _jobs = $state<UploadJob[]>([]);
let running = 0;
const queue: Array<{ id: string; file: File; folder: MutableFile }> = [];
const cancellers = new Map<string, () => void>();

export const uploads = {
  get jobs(): UploadJob[] {
    return _jobs;
  },
};

function findJob(id: string): UploadJob | undefined {
  // Returns the proxied entry from $state — mutations on this trigger UI updates.
  return _jobs.find((j) => j.id === id);
}

export function enqueueUpload(folder: MutableFile, file: File): UploadJob {
  const id = crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const job: UploadJob = {
    id,
    name: file.name,
    size: file.size,
    uploaded: 0,
    status: 'queued',
    folderId: folder.nodeId || '',
  };
  _jobs.push(job);
  queue.push({ id, file, folder });
  drain();
  return findJob(id) ?? job;
}

export function clearFinishedUploads() {
  _jobs = _jobs.filter((j) => j.status === 'queued' || j.status === 'uploading');
}

export function cancelUpload(jobId: string) {
  const job = findJob(jobId);
  if (!job) return;
  if (job.status === 'uploading' || job.status === 'queued') {
    job.status = 'cancelled';
    cancellers.get(jobId)?.();
    cancellers.delete(jobId);
  }
}

function scheduleAutoRemove(id: string) {
  setTimeout(() => {
    const j = findJob(id);
    if (!j) return;
    if (j.status === 'done' || j.status === 'cancelled') {
      _jobs = _jobs.filter((x) => x.id !== id);
    }
  }, AUTO_REMOVE_DONE_MS);
}

function drain() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    const job = findJob(next.id);
    if (!job || job.status === 'cancelled') continue;
    running++;
    run(next.id, next.file, next.folder).finally(() => {
      running--;
      cancellers.delete(next.id);
      drain();
    });
  }
}

async function run(id: string, file: File, folder: MutableFile) {
  const job = findJob(id);
  if (!job) return;
  job.status = 'uploading';
  let uploadStream: any;
  try {
    uploadStream = (folder as any).upload({ name: file.name, size: file.size });
    cancellers.set(id, () => {
      try {
        uploadStream?.destroy?.();
      } catch (_) {}
    });

    const reader = file.stream().getReader();
    while (true) {
      const current = findJob(id);
      if (!current || current.status === 'cancelled') {
        try {
          uploadStream.destroy();
        } catch (_) {}
        try {
          reader.cancel();
        } catch (_) {}
        scheduleAutoRemove(id);
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      const ok = uploadStream.write(value);
      current.uploaded += value.byteLength;
      if (!ok) {
        await new Promise<void>((resolve, reject) => {
          const onDrain = () => {
            uploadStream.off?.('drain', onDrain);
            uploadStream.off?.('error', onError);
            resolve();
          };
          const onError = (err: Error) => {
            uploadStream.off?.('drain', onDrain);
            uploadStream.off?.('error', onError);
            reject(err);
          };
          uploadStream.on('drain', onDrain);
          uploadStream.on('error', onError);
        });
      }
    }
    uploadStream.end();
    await uploadStream.complete;
    const done = findJob(id);
    if (done) {
      done.status = 'done';
      done.uploaded = done.size;
      scheduleAutoRemove(id);
    }
  } catch (err) {
    const failed = findJob(id);
    if (!failed) return;
    if (failed.status === 'cancelled') {
      scheduleAutoRemove(id);
      return;
    }
    failed.status = 'error';
    failed.error = err instanceof Error ? err.message : String(err);
  }
}
