import { v2 as cloudinary } from 'cloudinary';
import { logger } from '../logger.js';

const cloudName = process.env.CLOUDINARY_CLOUD_NAME ?? '';
const apiKey = process.env.CLOUDINARY_API_KEY ?? '';
const apiSecret = process.env.CLOUDINARY_API_SECRET ?? '';

cloudinary.config({ cloud_name: cloudName, api_key: apiKey, api_secret: apiSecret, secure: true });

const ROOT = `copeland/${process.env.NODE_ENV === 'production' ? 'production' : 'development'}`;
const PENDING_TAG = 'pending';
const ALLOWED_FORMATS = 'jpg,jpeg,png,webp';
const URL_PREFIX = `https://res.cloudinary.com/${cloudName}/image/upload/`;

export const partnerRoot = (partnerId: string) => `${ROOT}/partners/${partnerId}`;
export const productFolder = (partnerId: string) => `${partnerRoot(partnerId)}/products`;
export const documentFolder = (partnerId: string) => `${partnerRoot(partnerId)}/documents`;

/** Parameters the browser needs to upload one image straight to Cloudinary. */
export function createProductImageSignature(partnerId: string) {
  const params = {
    allowed_formats: ALLOWED_FORMATS,
    folder: productFolder(partnerId),
    tags: `${PENDING_TAG},partner_${partnerId},product`,
    timestamp: Math.round(Date.now() / 1000),
  };
  return {
    ...params,
    signature: cloudinary.utils.api_sign_request(params, apiSecret),
    apiKey,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`,
  };
}

/** Parameters for uploading private documents (PDFs/Images) to Cloudinary. */
export function createPartnerDocumentSignature(partnerId: string, documentType: string) {
  const params = {
    folder: documentFolder(partnerId),
    tags: `${PENDING_TAG},partner_${partnerId},document,${documentType}`,
    timestamp: Math.round(Date.now() / 1000),
  };
  return {
    ...params,
    signature: cloudinary.utils.api_sign_request(params, apiSecret),
    apiKey,
    uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/auto/upload`, // Use /auto/ for PDFs/images
  };
}

/** "https://res.cloudinary.com/x/image/upload/v123/a/b.jpg" -> "a/b". Returns null for foreign URLs. */
export function extractPublicId(url: string): string | null {
  if (!url.startsWith(URL_PREFIX)) return null;
  const path = url.slice(URL_PREFIX.length).split('?')[0];
  const withoutVersion = path.replace(/^v\d+\//, '');
  const dot = withoutVersion.lastIndexOf('.');
  return dot > 0 ? withoutVersion.slice(0, dot) : withoutVersion;
}

/** Throws unless every URL is an untransformed Cloudinary image in this partner's own folder. */
export function assertOwnedImages(urls: string[] | undefined, partnerId: string) {
  for (const url of urls ?? []) {
    const id = extractPublicId(url);
    if (!id || !id.startsWith(`${productFolder(partnerId)}/`)) {
      throw new Error('Images must be uploaded through Copeland image upload');
    }
  }
}

const toIds = (urls: string[]) => urls.map(extractPublicId).filter((id): id is string => !!id);
const chunk = <T,>(arr: T[], size = 100) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (_, i) => arr.slice(i * size, i * size + size));

/** Call after the product is saved: the images are now in use, so they must survive the orphan sweep. */
export async function markImagesAttached(urls: string[]) {
  const ids = toIds(urls);
  for (const batch of chunk(ids)) {
    try { await cloudinary.uploader.remove_tag(PENDING_TAG, batch); }
    catch (error) { logger.warn({ error }, 'Cloudinary remove_tag failed'); }
  }
}

/** Best-effort delete. Call it AFTER the database change commits, and never let it fail the request. */
export async function deleteImages(urls: string[]) {
  for (const batch of chunk(toIds(urls))) {
    try { await cloudinary.api.delete_resources(batch, { invalidate: true }); }
    catch (error) { logger.error({ error, batch }, 'Cloudinary delete failed'); }
  }
}

/** For when a partner account is removed: wipes everything under their folder. */
export async function deletePartnerAssets(partnerId: string) {
  const root = partnerRoot(partnerId);
  try {
    await cloudinary.api.delete_resources_by_prefix(root, { invalidate: true });
    await cloudinary.api.delete_folder(root);
  } catch (error) {
    logger.error({ error, partnerId }, 'Cloudinary partner cleanup failed');
  }
}

/** Run daily. Deletes uploads that were never attached to a product. */
export async function purgeOrphanedUploads(maxAgeHours = 24) {
  const cutoff = Date.now() - maxAgeHours * 3_600_000;
  const res = await cloudinary.api.resources_by_tag(PENDING_TAG, { max_results: 500 });
  const stale = (res.resources as { public_id: string; created_at: string }[])
    .filter((r) => new Date(r.created_at).getTime() < cutoff)
    .map((r) => r.public_id);
  for (const batch of chunk(stale)) await cloudinary.api.delete_resources(batch, { invalidate: true });
  return stale.length;
}