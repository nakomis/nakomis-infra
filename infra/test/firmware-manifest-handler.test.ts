import { createHash } from 'crypto';
import { Readable } from 'stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import type { S3Event } from 'aws-lambda';
import { compareVersions, handler } from '../lambda/firmware-manifest/index';

const s3Mock = mockClient(S3Client);

const BUCKET = 'nakomis-firmware-sandbox';
const MODIFIED = new Date('2026-10-11T12:00:00Z');

function s3Event(key: string): S3Event {
  return {
    Records: [{ s3: { bucket: { name: BUCKET }, object: { key } } }],
  } as unknown as S3Event;
}

function listing(project: string, versions: string[]) {
  return {
    Contents: versions.map(v => ({ Key: `${project}/${v}/firmware.bin`, Size: 1000, LastModified: MODIFIED })),
  };
}

function body(text: string) {
  // The SDK stream mixin adds transformToString; tests only need async iteration and that.
  const stream = Readable.from([Buffer.from(text)]) as Readable & { transformToString: () => Promise<string> };
  stream.transformToString = async () => text;
  return stream;
}

function writtenManifest() {
  const put = s3Mock.commandCalls(PutObjectCommand).find(c => c.args[0].input.Key?.endsWith('manifest.json'));
  expect(put).toBeDefined();
  return JSON.parse(put!.args[0].input.Body as string);
}

beforeEach(() => {
  s3Mock.reset();
  process.env.RETAIN_VERSIONS = '3';
  s3Mock.on(HeadObjectCommand).resolves({ Metadata: {} });
  s3Mock.on(PutObjectCommand).resolves({});
  s3Mock.on(DeleteObjectCommand).resolves({});
  // No previous manifest by default.
  s3Mock.on(GetObjectCommand, { Key: 'Proj/manifest.json' }).rejects(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));
});

describe('compareVersions', () => {
  test('orders numerically, not lexically', () => {
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0);
    expect(compareVersions('1.0.2', '1.0.10')).toBeLessThan(0);
    expect(compareVersions('2.0.0', '2.0.0')).toBe(0);
  });
});

describe('handler', () => {
  test('writes a manifest with sha256 computed from the object when metadata lacks it', async () => {
    s3Mock.on(ListObjectsV2Command).resolves(listing('Proj', ['1.0.0']));
    s3Mock.on(GetObjectCommand, { Key: 'Proj/1.0.0/firmware.bin' }).resolves({ Body: body('firmware-bytes') as never });

    await handler(s3Event('Proj/1.0.0/firmware.bin'));

    const manifest = writtenManifest();
    expect(manifest).toEqual({
      project: 'Proj',
      versions: [{
        version: '1.0.0',
        timestamp: MODIFIED.toISOString(),
        firmware_path: 'Proj/1.0.0/firmware.bin',
        size: 1000,
        sha256: createHash('sha256').update('firmware-bytes').digest('hex'),
      }],
    });
  });

  test('uses sha256 and signed from object metadata without downloading', async () => {
    s3Mock.on(ListObjectsV2Command).resolves(listing('Proj', ['1.0.0']));
    s3Mock.on(HeadObjectCommand).resolves({ Metadata: { sha256: 'AB'.repeat(32), signed: 'true' } });

    await handler(s3Event('Proj/1.0.0/firmware.bin'));

    const [v] = writtenManifest().versions;
    expect(v.sha256).toBe('ab'.repeat(32));
    expect(v.signed).toBe(true);
    expect(s3Mock.commandCalls(GetObjectCommand, { Key: 'Proj/1.0.0/firmware.bin' })).toHaveLength(0);
  });

  test('ignores malformed sha256 metadata and computes the hash instead', async () => {
    s3Mock.on(ListObjectsV2Command).resolves(listing('Proj', ['1.0.0']));
    s3Mock.on(HeadObjectCommand).resolves({ Metadata: { sha256: 'deadbeef' } });
    s3Mock.on(GetObjectCommand, { Key: 'Proj/1.0.0/firmware.bin' }).resolves({ Body: body('x') as never });

    await handler(s3Event('Proj/1.0.0/firmware.bin'));

    expect(writtenManifest().versions[0].sha256).toBe(createHash('sha256').update('x').digest('hex'));
  });

  test('reuses sha256 from the previous manifest for unchanged objects', async () => {
    s3Mock.on(ListObjectsV2Command).resolves(listing('Proj', ['1.0.0']));
    s3Mock.on(GetObjectCommand, { Key: 'Proj/manifest.json' }).resolves({
      Body: body(JSON.stringify({
        project: 'Proj',
        versions: [{ version: '1.0.0', timestamp: MODIFIED.toISOString(), firmware_path: 'Proj/1.0.0/firmware.bin', size: 1000, sha256: 'cd'.repeat(32) }],
      })) as never,
    });

    await handler(s3Event('Proj/1.0.0/firmware.bin'));

    expect(writtenManifest().versions[0].sha256).toBe('cd'.repeat(32));
    expect(s3Mock.commandCalls(GetObjectCommand, { Key: 'Proj/1.0.0/firmware.bin' })).toHaveLength(0);
  });

  test('keeps the newest RETAIN_VERSIONS versions and deletes the rest', async () => {
    s3Mock.on(ListObjectsV2Command).resolves(listing('Proj', ['1.0.9', '1.0.10', '1.0.1', '1.0.2']));
    s3Mock.on(HeadObjectCommand).resolves({ Metadata: { sha256: '00'.repeat(32) } });

    await handler(s3Event('Proj/1.0.10/firmware.bin'));

    expect(writtenManifest().versions.map((v: { version: string }) => v.version)).toEqual(['1.0.10', '1.0.9', '1.0.2']);
    const deleted = s3Mock.commandCalls(DeleteObjectCommand).map(c => c.args[0].input.Key);
    expect(deleted).toEqual(['Proj/1.0.1/firmware.bin']);
  });

  test('marks the project internal when any object has internal metadata', async () => {
    s3Mock.on(ListObjectsV2Command).resolves(listing('Proj', ['1.0.0']));
    s3Mock.on(HeadObjectCommand).resolves({ Metadata: { internal: 'true', sha256: '00'.repeat(32) } });

    await handler(s3Event('Proj/1.0.0/firmware.bin'));

    expect(writtenManifest().internal).toBe(true);
  });

  test('ignores keys that are not {project}/{version}/firmware.bin', async () => {
    await handler(s3Event('Proj/manifest.json'));
    await handler(s3Event('Proj/not-semver/firmware.bin'));

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test('ignores pre-release versions', async () => {
    await handler(s3Event('Proj/1.0.0-rc1/firmware.bin'));

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  test('skips non-semver version folders when listing', async () => {
    s3Mock.on(ListObjectsV2Command).resolves(listing('Proj', ['1.0.0', 'latest']));
    s3Mock.on(HeadObjectCommand).resolves({ Metadata: { sha256: '00'.repeat(32) } });

    await handler(s3Event('Proj/1.0.0/firmware.bin'));

    expect(writtenManifest().versions).toHaveLength(1);
  });

  test('decodes URL-encoded keys from the S3 event', async () => {
    s3Mock.on(ListObjectsV2Command).resolves(listing('My Proj', ['1.0.0']));
    s3Mock.on(HeadObjectCommand).resolves({ Metadata: { sha256: '00'.repeat(32) } });
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));

    await handler(s3Event('My+Proj/1.0.0/firmware.bin'));

    expect(writtenManifest().project).toBe('My Proj');
  });

  test('a removal rebuilds the manifest without the deleted version', async () => {
    // The listing no longer contains 1.0.1, but the previous manifest still does.
    s3Mock.on(ListObjectsV2Command).resolves(listing('Proj', ['1.0.0']));
    s3Mock.on(HeadObjectCommand).resolves({ Metadata: { sha256: '00'.repeat(32) } });
    s3Mock.on(GetObjectCommand, { Key: 'Proj/manifest.json' }).resolves({
      Body: body(JSON.stringify({
        project: 'Proj',
        versions: [
          { version: '1.0.1', timestamp: MODIFIED.toISOString(), firmware_path: 'Proj/1.0.1/firmware.bin', size: 1000, sha256: '11'.repeat(32) },
          { version: '1.0.0', timestamp: MODIFIED.toISOString(), firmware_path: 'Proj/1.0.0/firmware.bin', size: 1000, sha256: '00'.repeat(32) },
        ],
      })) as never,
    });

    await handler(s3Event('Proj/1.0.1/firmware.bin'));

    expect(writtenManifest().versions.map((v: { version: string }) => v.version)).toEqual(['1.0.0']);
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(0);
  });

  test('deletes the manifest when the last build is removed', async () => {
    s3Mock.on(ListObjectsV2Command).resolves({ Contents: [] });

    await handler(s3Event('Proj/1.0.0/firmware.bin'));

    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
    const deleted = s3Mock.commandCalls(DeleteObjectCommand).map(c => c.args[0].input.Key);
    expect(deleted).toEqual(['Proj/manifest.json']);
  });

  test('a failure on one record does not stop the others', async () => {
    s3Mock.on(ListObjectsV2Command, { Prefix: 'Bad/' }).rejects(new Error('boom'));
    s3Mock.on(ListObjectsV2Command, { Prefix: 'Proj/' }).resolves(listing('Proj', ['1.0.0']));
    s3Mock.on(HeadObjectCommand).resolves({ Metadata: { sha256: '00'.repeat(32) } });

    const event = s3Event('Bad/1.0.0/firmware.bin');
    event.Records.push(...s3Event('Proj/1.0.0/firmware.bin').Records);
    await expect(handler(event)).rejects.toThrow('Bad/1.0.0/firmware.bin');

    expect(writtenManifest().project).toBe('Proj');
  });
});

test('Pi tarballs get artefactType tarball; ESP32 manifests are unchanged', async () => {
  s3Mock.on(ListObjectsV2Command).resolves({
    Contents: [{ Key: 'Pish/1.2.0/artefact.tar.gz', Size: 5, LastModified: MODIFIED }],
  });
  s3Mock.on(HeadObjectCommand).resolves({ Metadata: { sha256: '00'.repeat(32) } });
  s3Mock.on(GetObjectCommand, { Key: 'Pish/manifest.json' }).rejects(Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }));

  await handler(s3Event('Pish/1.2.0/artefact.tar.gz'));

  const put = s3Mock.commandCalls(PutObjectCommand).find(c => c.args[0].input.Key === 'Pish/manifest.json');
  const manifest = JSON.parse(put!.args[0].input.Body as string);
  expect(manifest.artefactType).toBe('tarball');
  expect(manifest.versions[0].firmware_path).toBe('Pish/1.2.0/artefact.tar.gz');
});
