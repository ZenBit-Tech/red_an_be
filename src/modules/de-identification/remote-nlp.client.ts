import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  DE_ID_REMOTE_NLP_CONFIG,
  DE_ID_REMOTE_NLP_ENV,
  type ComplianceFramework,
} from '@common/constants/compliance.constants';

type RemoteNlpAnalyzeRequest = {
  text: string;
  threshold: number;
  framework: ComplianceFramework;
  entities: string[];
};

export type RemoteNlpAnalyzeResponseItem = {
  entity_type: string;
  start: number;
  end: number;
  score: number;
};

export type RemoteNlpHealthStatus = {
  status: 'ok';
};

@Injectable()
export default class RemoteNlpClient {
  private readonly remoteNlpUrl?: string;

  private readonly timeoutMs: number;

  private readonly retries: number;

  constructor(private readonly configService: ConfigService) {
    this.remoteNlpUrl = this.configService.get<string>(`${DE_ID_REMOTE_NLP_ENV.URL}`);

    const timeout = this.configService.get<number>(`${DE_ID_REMOTE_NLP_ENV.TIMEOUT_MS}`);
    const retries = this.configService.get<number>(`${DE_ID_REMOTE_NLP_ENV.RETRIES}`);

    this.timeoutMs = timeout ?? DE_ID_REMOTE_NLP_CONFIG.DEFAULT_TIMEOUT_MS;
    this.retries = retries ?? DE_ID_REMOTE_NLP_CONFIG.DEFAULT_RETRIES;
  }

  public isConfigured(): boolean {
    return Boolean(this.remoteNlpUrl);
  }

  public async analyze(request: RemoteNlpAnalyzeRequest): Promise<RemoteNlpAnalyzeResponseItem[]> {
    if (!this.remoteNlpUrl) {
      return [];
    }

    try {
      return await this.analyzeWithRetry(request, 0);
    } catch {
      throw new InternalServerErrorException('Remote NLP recognizer connection failed');
    }
  }

  public async healthCheck(): Promise<RemoteNlpHealthStatus> {
    if (!this.remoteNlpUrl) {
      throw new InternalServerErrorException('Remote NLP recognizer is not configured');
    }

    try {
      const response = await axios.get<RemoteNlpHealthStatus>(`${this.remoteNlpUrl}/health`, {
        timeout: this.timeoutMs,
      });

      return response.data;
    } catch {
      throw new InternalServerErrorException('Remote NLP recognizer health check failed');
    }
  }

  private async analyzeWithRetry(
    request: RemoteNlpAnalyzeRequest,
    attempt: number,
  ): Promise<RemoteNlpAnalyzeResponseItem[]> {
    try {
      const response = await axios.post<RemoteNlpAnalyzeResponseItem[]>(
        `${this.remoteNlpUrl}/analyze`,
        request,
        { timeout: this.timeoutMs },
      );

      return response.data;
    } catch (error: unknown) {
      if (attempt >= this.retries) {
        throw error;
      }

      return this.analyzeWithRetry(request, attempt + 1);
    }
  }
}
