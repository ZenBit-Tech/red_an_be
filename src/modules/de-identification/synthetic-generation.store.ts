import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ComplianceFramework } from '@common/constants/compliance.constants';
import { DE_ID_SYNTHETIC_GENERATION_STORE } from './de-identification.constants';
import { SyntheticOutputFormat } from './dto/request.dto';

export interface SyntheticEntityRow {
  variantNumber: number;
  entities: Record<string, string>;
}

export interface EntityInstanceMapping {
  instanceKey: string;
  category: string;
  start: number;
  end: number;
  originalValue: string;
}

export interface StoredSyntheticGeneration {
  jobId: string;
  userUuid: string;
  framework: ComplianceFramework;
  columns: string[];
  entityMappings: EntityInstanceMapping[];
  entityRows: SyntheticEntityRow[];
  outputFormat: SyntheticOutputFormat;
  originalText: string;
  baseOrdinal: number;
  generatedAt: Date;
  expiresAt: Date;
}

type StoredSyntheticGenerationInput = Omit<StoredSyntheticGeneration, 'generatedAt' | 'expiresAt'>;

@Injectable()
export default class SyntheticGenerationStore {
  private readonly store = new Map<string, StoredSyntheticGeneration>();

  save(data: StoredSyntheticGenerationInput): string {
    const generationId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DE_ID_SYNTHETIC_GENERATION_STORE.TTL_MS);
    this.store.set(generationId, { ...data, generatedAt: now, expiresAt });
    return generationId;
  }

  get(generationId: string): StoredSyntheticGeneration | null {
    const entry = this.store.get(generationId);
    if (!entry) {
      return null;
    }
    if (entry.expiresAt < new Date()) {
      this.store.delete(generationId);
      return null;
    }
    return entry;
  }

  delete(generationId: string): void {
    this.store.delete(generationId);
  }

  purgeExpired(): void {
    const now = new Date();
    this.store.forEach((entry, key) => {
      if (entry.expiresAt < now) {
        this.store.delete(key);
      }
    });
  }
}
