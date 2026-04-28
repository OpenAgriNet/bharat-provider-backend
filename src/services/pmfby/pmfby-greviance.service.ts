import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class PmfbyGrievanceService {
  private readonly logger = new Logger(PmfbyGrievanceService.name);

  constructor(
    private readonly configService?: ConfigService,
  ) { }

  async createGrievance(body: any) {
    console.log("createGrievance body--->>", body);
    return { success: true, message: "Grievance created successfully" };
  }
} 