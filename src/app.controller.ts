import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import AppService from './app.service';

@ApiTags('app root')
@Controller()
export default class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @ApiOperation({
    summary: 'Get a "hello world" message to check if the server is running',
  })
  @ApiOkResponse({ description: 'message sent successfully' })
  getHello(): string {
    return this.appService.getHello();
  }
}
