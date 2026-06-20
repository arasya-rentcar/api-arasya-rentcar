import { supabase } from '../config/supabase';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

const BUCKET = env.SUPABASE_STORAGE_BUCKET;

export async function uploadInvoicePDF(buffer: Buffer, fileName: string): Promise<string> {
  const storagePath = `invoices/${fileName}`;

  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: 'application/pdf',
    upsert: true,
  });

  if (error) {
    throw new AppError(`Storage upload failed: ${error.message}`, 500);
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

  return data.publicUrl;
}

// ── Sprint 3: generic file upload (payment proofs, car photos) ──────────
export const PAYMENT_PROOFS_BUCKET = "payment-proofs"; // private
export const CAR_PHOTOS_BUCKET = "car-photos"; // public

const ALLOWED_MIME = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024; // 10MB

const EXT_BY_MIME: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

export interface UploadedFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
  originalname?: string;
}

/** Validate a user-uploaded file (mime + size). Throws AppError on reject. */
export function assertValidUpload(file: UploadedFile | undefined): UploadedFile {
  if (!file || !file.buffer?.length) {
    throw new AppError("No file uploaded", 400);
  }
  if (!ALLOWED_MIME.has(file.mimetype)) {
    throw new AppError(
      `Unsupported file type: ${file.mimetype}. Allowed: JPEG, PNG, WebP, PDF.`,
      415,
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new AppError("File too large (max 10MB)", 413);
  }
  return file;
}

function randomName(mime: string): string {
  const ext = EXT_BY_MIME[mime] ?? "bin";
  const rand =
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  return `${rand}.${ext}`;
}

/**
 * Upload a validated file into a bucket under `prefix/`. Returns the storage
 * path (NOT a URL) plus the public URL when the bucket is public.
 * Filenames are randomized; client content-type is validated, not trusted blindly.
 */
export async function uploadFile(
  file: UploadedFile,
  opts: { bucket: string; prefix: string; public?: boolean },
): Promise<{ path: string; publicUrl: string | null }> {
  assertValidUpload(file);
  const storagePath = `${opts.prefix}/${randomName(file.mimetype)}`;
  const { error } = await supabase.storage
    .from(opts.bucket)
    .upload(storagePath, file.buffer, {
      contentType: file.mimetype,
      upsert: false,
    });
  if (error) {
    throw new AppError(`Storage upload failed: ${error.message}`, 500);
  }
  let publicUrl: string | null = null;
  if (opts.public) {
    publicUrl = supabase.storage.from(opts.bucket).getPublicUrl(storagePath)
      .data.publicUrl;
  }
  return { path: storagePath, publicUrl };
}

/** Create a time-limited signed URL for a private object (payment proofs). */
export async function getSignedUrl(
  bucket: string,
  path: string,
  expiresInSeconds = 60 * 60, // 1 hour
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, expiresInSeconds);
  if (error || !data?.signedUrl) {
    throw new AppError(
      `Failed to create signed URL: ${error?.message ?? "unknown"}`,
      500,
    );
  }
  return data.signedUrl;
}
