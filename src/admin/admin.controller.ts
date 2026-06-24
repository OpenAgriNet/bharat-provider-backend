import { Body, Controller, Get, Param, Post, Res, Put, Patch, Delete, UseGuards, HttpException, HttpStatus, UseInterceptors, UploadedFile, ValidationPipe, UsePipes, BadRequestException } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RoleGuard } from 'src/role.guard';
import { CreateUserDto } from '../dto/createUser.dto'
import { AdminService } from './admin.service';
import { LoggerService } from 'src/services/logger/logger.service';



@Controller('admin')
export class AdminController {

    constructor(public adminService: AdminService, private readonly logger: LoggerService) { }

    @Post('/registerAdmin')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("admin"))
    async createAdmin(@Body() createuserDto: CreateUserDto) {
        return this.adminService.createAdmin(createuserDto);
    }

    @Get('/getProviderList')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("admin"))
    async getProviderList() {
        return this.adminService.getProviderList();
    }

    @Get('/getProviderInfo/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("admin"))
    async getProviderInfoById(@Param('id') id) {
        return this.adminService.getProviderInfoById(id);
    }

    @Get('/getSeekerList')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("admin"))
    async getSeekerList() {
        return this.adminService.getSeekerList();
    }

    @Get('/getSeekerInfo/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("admin"))
    async getSeekerInfoById(@Param('id') id) {
        return this.adminService.getSeekerInfoById(id);
    }

    @Patch('/approval/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("admin"))
    async updateapprovalStatus(@Param('id') id, @Body() createUserDto?: CreateUserDto) {
        this.logger.log("createUserDto", createUserDto)
        const response = await this.adminService.updateapprovalStatus(id, createUserDto)
        return response;
    }

    @Patch('/enable/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("admin"))
    async updateEnableStatus(@Param('id') id, @Body() createUserDto?: CreateUserDto) {
        this.logger.log("createUserDto", createUserDto)
        const response = await this.adminService.updateEnableStatus(id, createUserDto)
        return response;
    }

}







