import { Injectable } from '@nestjs/common';
import * as winston from 'winston';

@Injectable()
export class LoggerService {
    private logger: winston.Logger;

    constructor() {
        const stringFormat = winston.format.printf(
            ({ timestamp, level, message, context, trace }) => {
                const prefix = context ? `${context} ` : '';
                const traceSuffix = trace ? `\n${trace}` : '';
                return `${timestamp} [${String(level).toUpperCase()}] ${prefix}${message}${traceSuffix}`;
            },
        );

        this.logger = winston.createLogger({
            level: 'info',
            format: winston.format.combine(
                winston.format.timestamp(),
                stringFormat,
            ),
            transports: [
                new winston.transports.Console(),
                new winston.transports.File({ filename: 'error.log', level: 'error' }),
                new winston.transports.File({ filename: 'combined.log' }),
            ],
        });
    }

    log(message: string, context?: string, level: string = "info") {
        this.logger.log({ level, message, context });
    }

    error(message: string, trace: string, context?: string) {
        this.logger.error({ message, trace, context });
    }

    warn(message: string, context?: string) {
        this.logger.warn({ message, context });
    }

    debug(message: string, context?: string) {
        this.logger.debug({ message, context });
    }
}
