export interface StorageObjectRef {
  ownerId: string;
  /** Opaque relative key chosen by the caller; validated by the adapter. */
  key: string;
}

/** Private object storage. There is intentionally no public-URL method. */
export interface StorageAdapter {
  put(ref: StorageObjectRef, data: Uint8Array): Promise<{ bytes: number }>;
  get(ref: StorageObjectRef): Promise<Uint8Array>;
  exists(ref: StorageObjectRef): Promise<boolean>;
  delete(ref: StorageObjectRef): Promise<void>;
  deleteOwner(ownerId: string): Promise<void>;
}

export class StorageError extends Error {
  constructor(
    public readonly code: "invalid_key" | "not_found",
    message: string,
  ) {
    super(message);
  }
}
