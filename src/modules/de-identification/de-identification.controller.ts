import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProduces, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import JwtAuthGuard from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import DeIdService from './de-identification.service';
import {
  AnalyzeRequestDto,
  BulkUpdateEntityStatusesRequestDto,
  GenerateSyntheticTableRequestDto,
  PreviewRequestDto,
  RegenerateSyntheticTableRequestDto,
} from './dto/request.dto';
import {
  AnalyzeResponseDto,
  BulkUpdateEntityStatusesResponseDto,
  GenerateSyntheticTableResponseDto,
  PreviewResponseDto,
  RegenerateSyntheticTableResponseDto,
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
    return this.deIdService.getPreviewWithValidation(dto, user.uuid);
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

  @Post('synthetic/generate')
  @ApiOperation({ summary: 'Generate synthetic data table (no archive download)' })
  @ApiOkResponse({ type: GenerateSyntheticTableResponseDto })
  async generateSyntheticTable(
    @Body() dto: GenerateSyntheticTableRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<GenerateSyntheticTableResponseDto> {
    return this.deIdService.generateSyntheticTable(dto, user.uuid);
  }

  @Get('synthetic/:generationId/download')
  @ApiOperation({ summary: 'Download ZIP archive for a generated synthetic dataset' })
  @ApiProduces('application/zip')
  @ApiOkResponse({
    description: 'ZIP archive for the specified generationId',
    schema: { type: 'string', format: 'binary' },
  })
  async downloadSyntheticArchive(
    @Param('generationId') generationId: string,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<StreamableFile> {
    const result = await this.deIdService.downloadSyntheticArchive(generationId, user.uuid);

    return new StreamableFile(result.archiveBuffer, {
      type: result.mimeType,
      disposition: `attachment; filename="${result.filename}"`,
    });
  }

  @Post('synthetic/:generationId/regenerate')
  @ApiOperation({ summary: 'Regenerate synthetic data table for an existing generation' })
  @ApiOkResponse({ type: RegenerateSyntheticTableResponseDto })
  async regenerateSyntheticTable(
    @Param('generationId') generationId: string,
    @Body() dto: RegenerateSyntheticTableRequestDto,
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<RegenerateSyntheticTableResponseDto> {
    return this.deIdService.regenerateSyntheticTable(generationId, dto, user.uuid);
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
