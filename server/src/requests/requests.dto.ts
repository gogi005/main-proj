import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsInt,
  IsPositive,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

export class CreateRequestLineDto {
  @IsString()
  materialId!: string;

  @IsInt()
  @IsPositive({ message: 'quantity must be a positive integer' })
  quantity!: number;
  // NOTE: no price fields accepted — server re-prices from the Material catalog.
}

export class CreateMaterialRequestDto {
  @IsString()
  projectId!: string;

  @MinLength(10, { message: 'justification must explain the need (min 10 chars)' })
  @MaxLength(2000)
  justification!: string;

  @IsDateString()
  needByDate!: string;

  /**
   * Client-generated UUID for offline-queue replay safety. If a request with the
   * same key already exists, the server returns the original response (200)
   * instead of creating a duplicate.
   */
  @IsString()
  idempotencyKey!: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateRequestLineDto)
  lines!: CreateRequestLineDto[];
}

export class DecideRequestDto {
  @IsString()
  @MaxLength(1000)
  comment?: string;
  // Required when rejecting — enforced in service against the actor's intent endpoint.
}

export class IssueStockLineDto {
  @IsString()
  lineId!: string;

  @IsInt()
  @IsPositive()
  quantity!: number;
}

export class IssueStockDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => IssueStockLineDto)
  lines!: IssueStockLineDto[];

  @IsString()
  note?: string;
}

export class ListRequestsQueryDto {
  @IsString()
  status?: string; // RequestStatus filter

  @IsString()
  projectId?: string;

  @IsInt()
  page?: number = 1;

  @IsInt()
  pageSize?: number = 20;
}
