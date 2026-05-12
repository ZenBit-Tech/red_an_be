import { Body, Controller, Get, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import JwtAuthGuard from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import DeIdService from './de-identification.service';
import {
  AnalyzeRequestDto,
  BulkUpdateEntityStatusesRequestDto,
  GenerateSyntheticVariantsRequestDto,
  PreviewRequestDto,
} from './dto/request.dto';
import {
  AnalyzeResponseDto,
  BulkUpdateEntityStatusesResponseDto,
  GenerateSyntheticVariantsResponseDto,
  PreviewResponseDto,
  RemoteNlpHealthResponseDto,
} from './dto/response.dto';
import { DeIdStatsQueryDto } from './dto/stats-query.dto';
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

  @Patch('entities/statuses')
  @ApiOperation({ summary: 'Persist active/inactive entity statuses for a job' })
  @ApiOkResponse({ type: BulkUpdateEntityStatusesResponseDto })
  async bulkUpdateEntityStatuses(
    @Body() dto: BulkUpdateEntityStatusesRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<BulkUpdateEntityStatusesResponseDto> {
    return this.deIdService.bulkUpdateEntityStatuses(dto, user.uuid);
  }

  @Post('synthetic')
  @ApiOperation({ summary: 'Generate N synthetic variants of de-identified text' })
  @ApiOkResponse({ type: GenerateSyntheticVariantsResponseDto })
  async generateSyntheticVariants(
    @Body() dto: GenerateSyntheticVariantsRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GenerateSyntheticVariantsResponseDto> {
    const result = await this.deIdService.generateSyntheticVariants(dto, user.uuid);
    const { archiveBuffer, ...response } = result;
    // In full implementation, archiveBuffer would be streamed as file download
    // For now, return metadata response
    return response;
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
  async getStats(
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DeIdStatsQueryDto,
  ): Promise<DeIdStatsResponseDto> {
    return this.statsService.getDashboardData(user.uuid, query);
  }
}
