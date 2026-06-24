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

    private isLogContext(value: unknown): value is string {
        return typeof value === 'string' && /^\[[^\]]+\]/.test(value);
    }

    private formatValue(value: unknown): string {
        if (value instanceof Error) {
            return value.message;
        }
        if (typeof value === 'object' && value !== null) {
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        }
        return String(value);
    }

    private resolveLogArgs(
        message: string,
        args: unknown[],
    ): { message: string; context?: string } {
        let context: string | undefined;
        const values: unknown[] = [];

        for (const arg of args) {
            if (this.isLogContext(arg)) {
                context = arg;
            } else if (arg !== undefined) {
                values.push(arg);
            }
        }

        if (!values.length) {
            return { message, context };
        }

        const suffix = values.map((value) => this.formatValue(value)).join(' ');
        const separator =
            message.endsWith(':') || message.endsWith(' ') || message.endsWith('...')
                ? ''
                : ' ';

        return {
            message: `${message}${separator}${suffix}`,
            context,
        };
    }

    log(message: string, ...args: unknown[]) {
        const { message: fullMessage, context } = this.resolveLogArgs(message, args);
        this.logger.log({ level: 'info', message: fullMessage, context });
    }

    error(message: string, trace?: unknown, context?: string) {
        let resolvedMessage = message;
        let resolvedTrace: string | undefined;
        let resolvedContext = context;

        if (trace instanceof Error) {
            resolvedTrace = trace.stack ?? trace.message;
        } else if (typeof trace === 'string') {
            if (this.isLogContext(trace) && !context) {
                resolvedContext = trace;
            } else if (!context) {
                const resolved = this.resolveLogArgs(message, [trace]);
                resolvedMessage = resolved.message;
                resolvedContext = resolved.context;
            } else {
                resolvedTrace = trace;
            }
        } else if (trace !== undefined) {
            const resolved = this.resolveLogArgs(message, [trace]);
            resolvedMessage = resolved.message;
            resolvedContext = resolved.context ?? context;
        }

        this.logger.error({
            message: resolvedMessage,
            trace: resolvedTrace,
            context: resolvedContext,
        });
    }

    warn(message: string, ...args: unknown[]) {
        const { message: fullMessage, context } = this.resolveLogArgs(message, args);
        this.logger.warn({ message: fullMessage, context });
    }

    debug(message: string, ...args: unknown[]) {
        const { message: fullMessage, context } = this.resolveLogArgs(message, args);
        this.logger.debug({ message: fullMessage, context });
    }
}

/** Shared logger for modules that are not Nest injectables (utils, bootstrap helpers). */
export const appLogger = new LoggerService();
