import { Injectable } from '@nestjs/common';
import { appLogger } from '../logger/logger.service';

@Injectable()
export class UtilService {
  generateRandomWord(length: number): string {
    const numbers = '0123456789';
    let number = '';
    for (let i = 0; i < length; i++) {
      const randomIndex = Math.floor(Math.random() * numbers.length);
      number += numbers.charAt(randomIndex);
    }
    return number;
  }

  generateReferralCode(email: string): string {
    const emailPrefix = email.substring(0, 4);
    const randomWord1 = this.generateRandomWord(1);
    const randomWord2 = this.generateRandomWord(1);
    // const randomWord3 = this.generateRandomWord(1);
    // const randomWord4 = this.generateRandomWord(1);
    appLogger.log("randomWord1", randomWord1)
    appLogger.log("randomWord2", randomWord2)
    const referralCode = `${emailPrefix}${randomWord1}${randomWord2}`.toUpperCase();
    appLogger.log(referralCode);
    return referralCode;
    ;
  }
}

