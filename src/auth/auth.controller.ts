import { Controller, Post, UseGuards, Request, Get, UsePipes, ValidationPipe, Res, Body, Param, UnauthorizedException, HttpException, HttpStatus } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { AuthService } from './auth.service';
import { OtpSendDTO } from './dto/otp-send.dto';
import { OtpVerifyDTO } from './dto/otp-verify.dto';
import {CreateUserDto} from '../dto/createUser.dto'
import { Response } from 'express';
import { LoggerService } from 'src/services/logger/logger.service';
import * as fs from 'fs';
import { promisify } from 'util';

@Controller('auth')
export class AuthController {

    constructor(private readonly authService: AuthService, private readonly logger: LoggerService) { }

    @Post('/registerUser')
    @UsePipes(ValidationPipe)
    async create(@Body() createUserDto: CreateUserDto) {
        this.logger.log('POST /register',`User Email Id : ${createUserDto.email}`);
        return this.authService.createUser(createUserDto);
    }
    
    @Post('/login')
    @UseGuards(AuthGuard("local"))
    login(@Request() request, @Res() response: Response) {
        this.logger.log('POST /login');
        this.logger.log("user", request.user)
        if(request.body.role !== request.user.role) {
            throw new UnauthorizedException
        }
        if(!request.user.approved) {
            throw new HttpException('User is not approved!', HttpStatus.UNAUTHORIZED);
        }
        if(!request.user.enable) {
            throw new HttpException('User is disabled!', HttpStatus.UNAUTHORIZED);
        }
        let token = this.authService.generateToken(request.user)
        this.logger.log('POST /login','logged In successfully')
        delete request.user.password
        return response.status(200).json({
            success: true,
            message: 'Logged in successfully!',
            data: {
                token: token,
                user: request.user
            }
        });
    }

    @Get('info-log')
    async infoLog() {
        try {
            const readFile = promisify(fs.readFile);
            const data = await readFile('combined.log', 'utf-8');
            return data;
        } catch (error) {
            // Handle errors, e.g., file not found or invalid JSON
            throw new Error('Unable to fetch data');
        }
    }

    @Get('error-log')
    async errorLog() {
        try {
            const readFile = promisify(fs.readFile);
            const data = await readFile('error.log', 'utf-8');
            return data;
        } catch (error) {
            // Handle errors, e.g., file not found or invalid JSON
            throw new Error('Unable to fetch data');
        }
    }

}
