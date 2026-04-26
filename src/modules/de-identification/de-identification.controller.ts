import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import JwtAuthGuard from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import DeIdService from './de-identification.service';
import { AnalyzeRequestDto, PreviewRequestDto } from './dto/request.dto';
import {
  AnalyzeResponseDto,
  PreviewResponseDto,
  RemoteNlpHealthResponseDto,
} from './dto/response.dto';
import { DeIdStatsResponseDto } from './dto/stats-response.dto';
import StatsService from './stats.service';

@ApiTags('De-Identification')
@ApiBearerAuth()
@Controller('de-identification')
@UseGuards(JwtAuthGuard)
export default class DeIdController {
  constructor(
    private readonly deIdService: DeIdService,
    private readonly statsService: StatsService,
  ) {}

  @Post('analyze')
  @ApiOperation({ summary: 'Step 2-3: Run PII Analysis' })
  @ApiOkResponse({ type: AnalyzeResponseDto })
  async analyze(
    @Body() dto: AnalyzeRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<AnalyzeResponseDto> {
    return this.deIdService.analyzeText(dto, user.uuid);
  }

  @Post('preview')
  @ApiOperation({ summary: 'Step 4: Interactive Anonymization Preview' })
  @ApiOkResponse({ type: PreviewResponseDto })
  async preview(
    @Body() dto: PreviewRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<PreviewResponseDto> {
    const text = await this.deIdService.getPreview(dto, user.uuid);
    return { anonymizedText: text };
  }

  @Get('remote-nlp/health')
  @ApiOperation({ summary: 'Remote NLP recognizer health check' })
  @ApiOkResponse({ type: RemoteNlpHealthResponseDto })
  async remoteNlpHealth(): Promise<RemoteNlpHealthResponseDto> {
    return this.deIdService.getRemoteNlpHealth();
  }

  @Get('stats')
  @ApiOperation({ summary: 'De-identification dashboard statistics' })
  @ApiOkResponse({ type: DeIdStatsResponseDto })
  async getStats(@CurrentUser() user: AuthenticatedUser): Promise<DeIdStatsResponseDto> {
    return this.statsService.getDashboardData(user.uuid);
  }
}
