import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { CustomRecognizer } from './recognizers/custom-recognizers.config';

// Heroku's router aborts an inbound request after 30s, so anything longer than
// this is dead time: the caller is already gone by the time Presidio answers.
const PRESIDIO_REQUEST_TIMEOUT_MS = 25_000;

// Warm-up is fire-and-forget: we only need the request to reach the dyno so it
// starts booting. We never wait for the answer.
const PRESIDIO_WARMUP_TIMEOUT_MS = 3_000;

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
    allowList: string[] = [],
  ): Promise<AnalyzerFinding[]> {
    try {
      const response = await axios.post<AnalyzerFinding[]>(
        `${this.analyzerUrl}/analyze`,
        {
          text,
          language: 'en',
          score_threshold: threshold,
          entities,
          ad_hoc_recognizers: adHocRecognizers,
          allow_list: allowList,
        },
        { timeout: PRESIDIO_REQUEST_TIMEOUT_MS },
      );
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
      const response = await axios.post<{ text: string }>(
        `${this.anonymizerUrl}/anonymize`,
        {
          text,
          analyzer_results: analyzerResults,
          operators,
        },
        { timeout: PRESIDIO_REQUEST_TIMEOUT_MS },
      );
      return response.data.text;
    } catch {
      throw new InternalServerErrorException('Presidio Anonymizer connection failed');
    }
  }

  /**
   * Wakes the Presidio analyzer without blocking the caller.
   *
   * On Eco dynos Presidio sleeps after 30 minutes of inactivity and its cold
   * start (spaCy model load) can exceed the 30s Heroku router limit. Pinging it
   * when the user opens the de-identification page gives it a head start while
   * they are still pasting text, so the real request lands on a warm service.
   *
   * Failures are deliberately ignored - a failed ping still triggers the boot.
   */
  public warmUp(): void {
    void axios
      .get(`${this.analyzerUrl}/health`, { timeout: PRESIDIO_WARMUP_TIMEOUT_MS })
      .catch(() => undefined);
  }
}
