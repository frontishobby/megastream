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
  cancel?: () => void;
}

const MAX_CONCURRENT = 3;

let _jobs = $state<UploadJob[]>([]);
let running = 0;
const queue: Array<{ job: UploadJob; file: File; folder: MutableFile }> = [];

export const uploads = {
  get jobs(): UploadJob[] {
    return _jobs;
  },
};

export function enqueueUpload(folder: MutableFile, file: File): UploadJob {
  const job: UploadJob = {
    id: crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    name: file.name,
    size: file.size,
    uploaded: 0,
    status: 'queued',
    folderId: folder.nodeId || '',
  };
  _jobs = [..._jobs, job];
  queue.push({ job, file, folder });
  drain();
  return job;
}

export function clearFinishedUploads() {
  _jobs = _jobs.filter((j) => j.status === 'queued' || j.status === 'uploading');
}

export function cancelUpload(jobId: string) {
  const job = _jobs.find((j) => j.id === jobId);
  if (!job) return;
  if (job.status === 'uploading' || job.status === 'queued') {
    job.status = 'cancelled';
    job.cancel?.();
  }
}

function drain() {
  while (running < MAX_CONCURRENT && queue.length > 0) {
    const next = queue.shift();
    if (!next) break;
    if (next.job.status === 'cancelled') continue;
    running++;
    run(next).finally(() => {
      running--;
      drain();
    });
  }
}

async function run({ job, file, folder }: { job: UploadJob; file: File; folder: MutableFile }) {
  job.status = 'uploading';
  let uploadStream: any;
  try {
    uploadStream = (folder as any).upload({ name: file.name, size: file.size });
    job.cancel = () => {
      try {
        uploadStream?.destroy?.();
      } catch (_) {}
    };

    const reader = file.stream().getReader();
    while (true) {
      // @ts-expect-error — UploadJob status is mutated externally on cancel
      if (job.status === 'cancelled') {
        try {
          uploadStream.destroy();
        } catch (_) {}
        try {
          reader.cancel();
        } catch (_) {}
        return;
      }
      const { value, done } = await reader.read();
      if (done) break;
      const ok = uploadStream.write(value);
      job.uploaded += value.byteLength;
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
    job.status = 'done';
    job.uploaded = job.size;
  } catch (err) {
    // @ts-expect-error — see above
    if (job.status === 'cancelled') return;
    job.status = 'error';
    job.error = err instanceof Error ? err.message : String(err);
  }
}
