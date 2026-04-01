import { Injectable } from '@nestjs/common';
import { HELLO_MESSAGE } from './common/constants';

@Injectable()
export default class AppService {
  private readonly helloMsg: string = HELLO_MESSAGE;

  getHello(): string {
    return this.helloMsg;
  }
}
