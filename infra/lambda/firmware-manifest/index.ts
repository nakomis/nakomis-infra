import { createHash } from 'crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import type { S3Event } from 'aws-lambda';

// Ported from sandboxsite/infra/lambda/firmware-processor. Manifest shape is unchanged so existing
// readers keep working; sha256 and signed are optional additions for Fleet's secure tier.

const s3 = new S3Client({});

const DEFAULT_RETAIN_VERSIONS = 10;
// Plain x.y.z only: pre-release suffixes would tie with their release and make pruning order undefined.
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
// ESP32 images are firmware.bin; Raspberry Pi releases (nakomis-fleet's agent) are artefact.tar.gz.
const FIRMWARE_KEY = /^([^/]+)\/([^/]+)\/(firmware\.bin|artefact\.tar\.gz)$/;
const ARTEFACT_TYPES: Record<string, 'bin' | 'tarball'> = { 'firmware.bin': 'bin', 'artefact.tar.gz': 'tarball' };
const SHA256_HEX = /^[0-9a-f]{64}$/;

export interface ManifestVersion {
  version: string;
  timestamp: string;
  firmware_path: string;
  size: number;
  sha256?: string;
  signed?: boolean;
}

export interface Manifest {
  project: string;
  versions: ManifestVersion[];
  internal?: boolean;
  /** Omitted for ESP32 firmware ("bin"), so existing readers see the manifest they always have. */
  artefactType?: 'tarball';
}

interface FirmwareObject {
  artefactType: 'bin' | 'tarball';
  version: string;
  key: string;
  size: number;
  lastModified: Date;
}

function parseVersion(version: string): [number, number, number] | undefined {
  const match = version.match(SEMVER);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

export function compareVersions(a: string, b: string): number {
  const [pa, pb] = [parseVersion(a)!, parseVersion(b)!];
  return pa[0] - pb[0] || pa[1] - pb[1] || pa[2] - pb[2];
}

async function listFirmware(bucket: string, project: string): Promise<FirmwareObject[]> {
  const objects: FirmwareObject[] = [];
  let ContinuationToken: string | undefined;
  do {
    const page = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${project}/`, ContinuationToken }));
    for (const obj of page.Contents ?? []) {
      const match = obj.Key?.match(FIRMWARE_KEY);
      if (!match || !parseVersion(match[2])) continue;
      objects.push({ artefactType: ARTEFACT_TYPES[match[3]], version: match[2], key: obj.Key!, size: obj.Size ?? 0, lastModified: obj.LastModified ?? new Date() });
    }
    ContinuationToken = page.NextContinuationToken;
  } while (ContinuationToken);
  return objects;
}

async function readPreviousManifest(bucket: string, project: string): Promise<Manifest | undefined> {
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: `${project}/manifest.json` }));
    return JSON.parse(await res.Body!.transformToString()) as Manifest;
  } catch {
    return undefined;
  }
}

async function hashObject(bucket: string, key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const hash = createHash('sha256');
  for await (const chunk of res.Body as AsyncIterable<Uint8Array>) hash.update(chunk);
  return hash.digest('hex');
}

async function describe(
  bucket: string,
  obj: FirmwareObject,
  previous: Manifest | undefined,
): Promise<{ entry: ManifestVersion; internal: boolean }> {
  // S3 lowercases user metadata keys.
  const meta = (await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: obj.key }))).Metadata ?? {};
  const timestamp = obj.lastModified.toISOString();

  const cached = previous?.versions.find(v =>
    v.firmware_path === obj.key && v.size === obj.size && v.timestamp === timestamp && v.sha256);
  // Uploader-supplied hashes are taken on trust if well-formed (devices verify images themselves);
  // otherwise compute our own.
  const supplied = meta.sha256?.toLowerCase();
  const sha256 = (supplied && SHA256_HEX.test(supplied) ? supplied : undefined)
    ?? cached?.sha256 ?? await hashObject(bucket, obj.key);

  const entry: ManifestVersion = { version: obj.version, timestamp, firmware_path: obj.key, size: obj.size, sha256 };
  if (meta.signed === 'true') entry.signed = true;
  return { entry, internal: meta.internal === 'true' };
}

async function processKey(bucket: string, key: string): Promise<void> {
  const match = key.match(FIRMWARE_KEY);
  if (!match || !parseVersion(match[2])) {
    console.log(`Skipping non-firmware key: ${key}`);
    return;
  }
  const project = match[1];
  const retain = Number(process.env.RETAIN_VERSIONS) || DEFAULT_RETAIN_VERSIONS;

  const all = (await listFirmware(bucket, project)).sort((a, b) => compareVersions(b.version, a.version));
  if (all.length === 0) {
    // The last build was deleted: a stale manifest would offer builds that no longer exist.
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: `${project}/manifest.json` }));
    console.log(`No firmware left for ${project}; deleted its manifest`);
    return;
  }

  const keep = all.slice(0, retain);
  // The bucket is versioned, so deleted builds stay recoverable until the noncurrent-version lifecycle expires them.
  for (const old of all.slice(retain)) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: old.key }));
    console.log(`Deleted old firmware ${old.key}`);
  }

  const previous = await readPreviousManifest(bucket, project);
  const described = [];
  for (const obj of keep) described.push(await describe(bucket, obj, previous));

  const manifest: Manifest = { project, versions: described.map(d => d.entry) };
  if (described.some(d => d.internal)) manifest.internal = true;
  if (keep[0].artefactType === 'tarball') manifest.artefactType = 'tarball';

  await s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key: `${project}/manifest.json`,
    Body: JSON.stringify(manifest, null, 2),
    ContentType: 'application/json',
    CacheControl: 'no-cache',
  }));
  console.log(`Wrote ${project}/manifest.json with ${manifest.versions.length} versions`);
}

export const handler = async (event: S3Event): Promise<void> => {
  const failures: string[] = [];
  for (const record of event.Records) {
    const bucket = record.s3.bucket.name;
    const key = decodeURIComponent(record.s3.object.key.replace(/\+/g, ' '));
    try {
      await processKey(bucket, key);
    } catch (err) {
      console.error(`Failed to process s3://${bucket}/${key}`, err);
      failures.push(key);
    }
  }
  // Rethrow so Lambda's async retries get another go rather than leaving a stale manifest.
  if (failures.length > 0) throw new Error(`Failed to process: ${failures.join(', ')}`);
};
