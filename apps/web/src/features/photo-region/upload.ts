import { ApiError, parseEnvelope } from "../../lib/api";
import { clearSessionState, csrfHeaders, ensureSession } from "../../lib/session";
import type { MediaInfo } from "./types";

export interface UploadHandle {
  promise: Promise<MediaInfo>;
  cancel: () => void;
}

function xhrOnce(file: File, farmId: string, key: string, onProgress: (fraction: number) => void, register: (abort: () => void) => void): Promise<MediaInfo> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    register(() => xhr.abort());
    xhr.open("POST", `/api/v1/media?farmId=${encodeURIComponent(farmId)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("accept", "application/json");
    xhr.setRequestHeader("idempotency-key", key);
    for (const [k, v] of Object.entries(csrfHeaders("POST"))) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onerror = () => reject(new ApiError("network_error", "Could not reach the server. Check your connection and try again.", 0));
    xhr.onabort = () => reject(new ApiError("cancelled", "Upload cancelled.", 0));
    xhr.ontimeout = () => reject(new ApiError("timeout", "The upload took too long. Try again on a better connection.", 0));
    xhr.timeout = 120_000;
    xhr.onload = () => {
      let json: unknown;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        reject(new ApiError("invalid_response", `Server returned an unreadable response (HTTP ${xhr.status})`, xhr.status));
        return;
      }
      try {
        const env = parseEnvelope<MediaInfo>(json, xhr.status);
        if (xhr.status >= 200 && xhr.status < 300 && env.data) resolve(env.data);
        else reject(new ApiError(env.error?.code ?? "http_error", env.error?.message ?? `HTTP ${xhr.status}`, xhr.status, env.requestId));
      } catch (e) {
        reject(e);
      }
    };
    const fd = new FormData();
    fd.append("file", file);
    xhr.send(fd);
  });
}

/**
 * Uploads one image with an Idempotency-Key (the stable client entry id) so a retry of the same selection
 * cannot create a second media object. Reports progress as 0..1; cancel() aborts the in-flight request.
 */
export function uploadPhoto(file: File, farmId: string, entryKey: string, onProgress: (fraction: number) => void): UploadHandle {
  let abort: () => void = () => undefined;
  let cancelled = false;
  const promise = (async () => {
    await ensureSession();
    try {
      return await xhrOnce(file, farmId, entryKey, onProgress, (a) => (abort = a));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401 && !cancelled) {
        clearSessionState();
        if (await ensureSession()) return xhrOnce(file, farmId, entryKey, onProgress, (a) => (abort = a));
      }
      throw e;
    }
  })();
  return {
    promise,
    cancel: () => {
      cancelled = true;
      abort();
    },
  };
}

export function uploadErrorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    switch (e.code) {
      case "payload_too_large":
        return "That photo is too large for the server. Choose a smaller one.";
      case "unsupported_media_type":
        return "Only JPEG, PNG or WebP photos can be used.";
      case "invalid_image":
      case "image_too_large":
        return "That file could not be read as a photo. Try a different one.";
      case "rate_limited":
        return "Too many requests. Wait a minute and try again.";
      default:
        return e.message;
    }
  }
  return "The upload failed. Try again.";
}
