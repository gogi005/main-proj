import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createHash, randomBytes } from 'crypto';

/** MIME types we accept for photo assets — everything else is rejected at presign time. */
export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/heic', 'image/webp'] as const;

const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/heic': 'heic',
  'image/webp': 'webp',
};

export interface PresignedUpload {
  uploadUrl: string;
  method: 'PUT';
  s3Key: string;
  /** Client MUST send this exact Content-Type header on the PUT. */
  requiredContentType: string;
  expiresAt: string; // ISO — after this the URL is dead
}

export interface SignedView {
  url: string;
  expiresAt: string;
}

/**
 * S3 object storage wrapper.
 * SECURITY MODEL:
 *  - Clients NEVER choose object keys. The server generates a random, unguessable
 *    key namespaced by project → path traversal / IDOR via key is impossible.
 *  - Presigned PUT URLs are short-lived (default 5 min) and bound to one
 *    Content-Type + Content-Length, so a leaked URL cannot be reused for
 *    arbitrary or oversized content.
 *  - Reads are ALWAYS via short-lived presigned GETs (bucket stays private).
 */
@Injectable()
export class StorageService {
  private readonly logger = new Logger(StorageService.name);
  private readonly bucket: string;
  private readonly presignTtlSec: number;
  private readonly s3: S3Client;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('S3_BUCKET');
    this.presignTtlSec = Number(config.get('PRESIGN_UPLOAD_TTL_SECONDS') ?? 300);
    this.s3 = new S3Client({ region: config.getOrThrow<string>('AWS_REGION') });
  }

  /** Server-generated key: photos/<project>/<yyyy-mm>/<random>.<ext> */
  generateKey(projectId: string, mimeType: string): string {
    if (!this.isAllowedMime(mimeType)) {
      throw new Error(`Unsupported mime type: ${mimeType}`);
    }
    const ym = new Date().toISOString().slice(0, 7);
    const rand = randomBytes(16).toString('hex');
    return `photos/${projectId}/${ym}/${rand}.${EXT_BY_MIME[mimeType] ?? 'bin'}`;
  }

  async presignUpload(s3Key: string, mimeType: string, contentLength: number): Promise<PresignedUpload> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: s3Key,
      ContentType: mimeType,
      ContentLength: contentLength,
      ServerSideEncryption: 'AES256',
      ACL: 'private', // defense in depth — bucket policy already blocks public access
    });
    const url = await getSignedUrl(this.s3, command, { expiresIn: this.presignTtlSec });
    return {
      uploadUrl: url,
      method: 'PUT',
      s3Key,
      requiredContentType: mimeType,
      expiresAt: new Date(Date.now() + this.presignTtlSec * 1000).toISOString(),
    };
  }

  /** Short-lived GET URL for viewing an object (moderation queue + approved galleries). */
  async presignView(s3Key: string, ttlSec = 900): Promise<SignedView> {
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: s3Key });
    const url = await getSignedUrl(this.s3, command, { expiresIn: ttlSec });
    return { url, expiresAt: new Date(Date.now() + ttlSec * 1000).toISOString() };
  }

  async deleteObject(s3Key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: s3Key }));
    this.logger.log(`Deleted S3 object ${s3Key}`);
  }

  /** Integrity helper — SHA-256 over raw bytes fetched back from S3. */
  static sha256Hex(buffer: Buffer): string {
    return createHash('sha256').update(buffer).digest('hex');
  }

  isAllowedMime(mimeType: string): boolean {
    return (ALLOWED_IMAGE_MIME as readonly string[]).includes(mimeType);
  }
}
