import { Body, Controller, Get, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import DeIdService from './de-identification.service';
import { AnalyzeRequestDto, PreviewRequestDto } from './dto/request.dto';
import { DeIdStatsResponseDto } from './dto/stats-response.dto';
import StatsService from './stats.service';

@ApiTags('De-Identification')
@Controller('de-identification')
export default class DeIdController {
  constructor(
    private readonly deIdService: DeIdService,
    private readonly statsService: StatsService,
  ) {}

  @Post('analyze')
  @ApiOperation({ summary: 'Step 2-3: Run PII Analysis' })
  async analyze(@Body() dto: AnalyzeRequestDto) {
    return this.deIdService.analyzeText(dto);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Step 4: Interactive Anonymization Preview' })
  async preview(@Body() dto: PreviewRequestDto) {
    const text = await this.deIdService.getPreview(dto);
    return { anonymizedText: text };
  }

  @Get('remote-nlp/health')
  @ApiOperation({ summary: 'Remote NLP recognizer health check' })
  async remoteNlpHealth() {
    return this.deIdService.getRemoteNlpHealth();
  }

  @Get('stats')
  @ApiOperation({ summary: 'De-identification dashboard statistics' })
  @ApiOkResponse({ type: DeIdStatsResponseDto })
  async getStats(): Promise<DeIdStatsResponseDto> {
    return this.statsService.getDashboardData();
  }
}
