import { supabase } from '../config/supabase';
import { env } from '../config/env';
import { AppError } from '../utils/AppError';

const BUCKET = env.SUPABASE_STORAGE_BUCKET;

export async function uploadInvoicePDF(buffer: Buffer, fileName: string): Promise<string> {
  const storagePath = `invoices/${fileName}`;

  const { error } = await supabase.storage.from(BUCKET).upload(storagePath, buffer, {
    contentType: 'application/pdf',
    upsert: false,
  });

  if (error) {
    throw new AppError(`Storage upload failed: ${error.message}`, 500);
  }

  const { data } = supabase.storage.from(BUCKET).getPublicUrl(storagePath);

  return data.publicUrl;
}
