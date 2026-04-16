import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { CustomRecognizer } from './recognizers/custom-recognizers.config';

type AnalyzerFinding = {
  entity_type: string;
  start: number;
  end: number;
  score: number;
};

type AnonymizerOperator = {
  type: string;
  new_value?: string;
  hash_type?: string;
  masking_char?: string;
  chars_to_mask?: number;
  from_start?: boolean;
};

@Injectable()
export default class PresidioClient {
  private readonly analyzerUrl: string;

  private readonly anonymizerUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.analyzerUrl = this.configService.getOrThrow<string>('PRESIDIO_ANALYZER_URL');
    this.anonymizerUrl = this.configService.getOrThrow<string>('PRESIDIO_ANONYMIZER_URL');
  }

  public async analyze(
    text: string,
    threshold: number,
    entities: string[],
    adHocRecognizers: CustomRecognizer[] = [],
  ): Promise<AnalyzerFinding[]> {
    try {
      const response = await axios.post<AnalyzerFinding[]>(`${this.analyzerUrl}/analyze`, {
        text,
        language: 'en',
        score_threshold: threshold,
        entities,
        ad_hoc_recognizers: adHocRecognizers,
      });
      return response.data;
    } catch {
      throw new InternalServerErrorException('Presidio Analyzer connection failed');
    }
  }

  public async anonymize(
    text: string,
    analyzerResults: AnalyzerFinding[],
    operators: Record<string, AnonymizerOperator>,
  ): Promise<string> {
    try {
      const response = await axios.post<{ text: string }>(`${this.anonymizerUrl}/anonymize`, {
        text,
        analyzer_results: analyzerResults,
        operators,
      });
      return response.data.text;
    } catch {
      throw new InternalServerErrorException('Presidio Anonymizer connection failed');
    }
  }
}
