/**
 * XHR-based file upload with progress. fetch() gives no upload progress events,
 * so staged uploads (Compose) and shared-folder uploads (ShareBrowser) go
 * through XMLHttpRequest to drive per-file progress bars.
 */

export interface UploadResult {
  ok: boolean;
  status: number;
}

export interface UploadOptions {
  /** Extra request headers (e.g. the passcode header from authHeaders()). */
  headers?: Record<string, string>;
  /** Called with upload progress as a fraction in [0, 1] while sending. */
  onProgress?: (fraction: number) => void;
}

/**
 * POST a single file to `url`, reporting upload progress. Resolves with the
 * HTTP status (never rejects on 4xx/5xx — the caller inspects `ok`); rejects
 * only on network/abort errors, mirroring the previous fetch().catch path.
 */
export function uploadWithProgress(
  url: string,
  file: File,
  opts: UploadOptions = {},
): Promise<UploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    // Bound the whole request so a stalled server can't leave the caller
    // pending (and the UI stuck on "Sending…") forever: 60s base plus 1s per
    // 100 KiB, so big files on a slow LAN still have time to finish.
    xhr.timeout = 60_000 + Math.ceil(file.size / (100 * 1024)) * 1000;
    xhr.setRequestHeader(
      "Content-Type",
      file.type || "application/octet-stream",
    );
    for (const [key, value] of Object.entries(opts.headers ?? {})) {
      xhr.setRequestHeader(key, value);
    }
    if (opts.onProgress) {
      xhr.upload.onprogress = (e: ProgressEvent) => {
        if (e.lengthComputable && e.total > 0) {
          opts.onProgress!(e.loaded / e.total);
        }
      };
    }
    xhr.onload = () => {
      if (opts.onProgress) opts.onProgress(1);
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status });
    };
    xhr.onerror = () => reject(new Error("network error"));
    xhr.onabort = () => reject(new Error("aborted"));
    xhr.ontimeout = () => reject(new Error("timeout"));
    xhr.send(file);
  });
}
