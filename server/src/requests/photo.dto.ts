import { IsDateString, IsIn, IsInt, IsPositive, IsString, Matches, Min } from 'class-validator';
import { PhotoSubjectType } from '@prisma/client';

/** Client proposes a mime type + size; the server validates and mints the key. */
export class PresignUploadDto {
  @IsString()
  projectId!: string;

  @IsIn(Object.values(PhotoSubjectType))
  subjectType!: PhotoSubjectType;

  /** Optional request this photo documents (required for MATERIAL_REQUEST/DELIVERY_PROOF). */
  @IsString()
  requestId?: string;

  @Matches(/^image\/(jpeg|png|heic|webp)$/, { message: 'only jpeg/png/heic/webp allowed' })
  mimeType!: string;

  @IsInt()
  @IsPositive()
  @Min(1)
  byteSize!: number; // must match what is PUT to S3

  @IsDateString()
  takenAt!: string; // EXIF capture time from device
}

export class CompleteUploadDto {
  /** Key returned by the presign endpoint — echoed back, never client-chosen. */
  @IsString()
  s3Key!: string;
}

export class ModeratePhotoDto {
  @IsString()
  @Matches(/.{5,1000}/, { message: 'reason/comment required (min 5 chars)' })
  reason!: string;
}
