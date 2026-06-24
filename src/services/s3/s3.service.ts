import { Injectable } from '@nestjs/common';
import {
    S3Client,
    PutObjectCommand,
    PutObjectCommandInput,
    PutObjectCommandOutput,
    GetObjectCommand
} from "@aws-sdk/client-s3";
import { ConfigService } from '@nestjs/config';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { LoggerService } from '../logger/logger.service';

@Injectable()
export class S3Service {
    private region: string;
    private s3: S3Client;

    constructor(private configService: ConfigService, private readonly logger: LoggerService) {
        this.region = this.configService.get<string>('S3_REGION')
        this.s3 = new S3Client({
            region: this.region,
            credentials: {
                secretAccessKey: this.configService.get<string>('SECRET_ACCESS_KEY'),
                accessKeyId: this.configService.get<string>('ACCESS_KEY_ID')
            }
        })
    }

    async uploadFile(file: Express.Multer.File, key: string) {
        this.logger.log("inside upload file")
        const bucket = this.configService.get<string>('S3_BUCKET')
        const expiresIn = this.configService.get<number>('EXPIRES_IN')
        const input: PutObjectCommandInput = {
            Body: file.buffer,
            Bucket: bucket,
            Key: key,
            ContentType: file.mimetype
        };
        this.logger.log("input", input)
        try {
            const response: PutObjectCommandOutput = await this.s3.send(
                new PutObjectCommand(input),
            );
            this.logger.log("response", response)
            if (response.$metadata.httpStatusCode === 200) {
                const client = this.s3;
                const command = new GetObjectCommand({ Bucket: bucket, Key: key });
                return getSignedUrl(client, command, { expiresIn: expiresIn });
            }
            throw new Error('File not saved to s3!')
        } catch (err) {
            this.logger.log("uploadFile err", err)
        }
    }

    async getFileUrl(key: string) {
        this.logger.log("inside getFileUrl")
        const bucket = this.configService.get<string>('S3_BUCKET')
        const expiresIn = this.configService.get<number>('EXPIRES_IN')
        
        try {
            const client = this.s3;
            const command = new GetObjectCommand({ Bucket: bucket, Key: key });
            return getSignedUrl(client, command, { expiresIn: expiresIn });
            
        } catch (err) {
            this.logger.log("getFileUrl err", err)
        }
    }
}
