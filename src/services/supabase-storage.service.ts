import { createClient } from '@supabase/supabase-js';

function client() {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for document storage');
  return createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function privateBucket() {
  const supabase = client();
  const bucketName = process.env.SUPABASE_PRIVATE_BUCKET ?? 'partner-documents';
  const { data, error } = await supabase.storage.getBucket(bucketName);
  if (error) throw new Error(`Unable to verify private document bucket: ${error.message}`);
  if (data.public) throw new Error('Partner document bucket must be private');
  return supabase.storage.from(bucketName);
}

export async function createPartnerDocumentUpload(path: string) {
  const { data, error } = await (await privateBucket()).createSignedUploadUrl(path);
  if (error) throw new Error(`Unable to create document upload URL: ${error.message}`);
  return data;
}

export async function createPartnerDocumentDownload(path: string) {
  const { data, error } = await (await privateBucket()).createSignedUrl(path, 60);
  if (error) throw new Error(`Unable to create document download URL: ${error.message}`);
  return data;
}
