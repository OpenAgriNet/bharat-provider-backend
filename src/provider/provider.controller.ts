import { Controller,Post,UseGuards,Request, Body, Get, Patch, Param, Delete, UseInterceptors, UploadedFile} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { RoleGuard } from 'src/role.guard';
import {ProviderService} from './provider.service'
import {LoggerService} from '../services/logger/logger.service'
import {CreateContentDto} from '../dto/createContent.dto'
import { ResetPasswordDto } from 'src/dto/resetPassword.dto';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { createReadStream } from 'fs';
import * as csvParser from 'csv-parser';
import { ScholarshipDto } from 'src/dto/scholarship.dto';
import { CreateIcarContentDto } from 'src/dto/createIcarContent.dto';

@Controller('provider')
export class ProviderController {
    
    constructor(private readonly providerService:ProviderService, private readonly logggerService:LoggerService, private readonly logger: LoggerService) {}

    @Post('/content')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async createContent(@Request() request,@Body() createContentdto?:CreateContentDto){
        this.logger.log("user", request.user);
        this.logger.log("createContentdto", createContentdto);
        this.logggerService.log('POST /createContent',request.user.id);
        let id = request.user.id
        this.logger.log("id",id)
        return this.providerService.createContent(id,createContentdto)
    }

    @Get('/content')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async getContent(@Request() request){
        this.logggerService.log('GET /getContent',request.user.id);
        return this.providerService.getContent(request.user.id)
    }

    @Get('/contentById/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async getContentById(@Request() request, @Param('id') id){
        this.logggerService.log('GET /getContent',request.user.id);
        return this.providerService.getContentById(id, request.user.id)
    }

    @Patch('/content/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async editContent(@Request() request,@Param('id') id, @Body() createContentdto?:CreateContentDto){
        this.logger.log("createContentdto", createContentdto);
        return this.providerService.editContent(id,createContentdto)
    }

    @Delete('/content/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async deleteContent(@Request() request, @Param('id') id){
        this.logggerService.log('POST /deleteContent',request.user.id);
        let provider_id = request.user.id
        this.logger.log("provider_id",provider_id)
        this.logger.log("id",id)
        return this.providerService.deleteContent(id, provider_id)
    }

    @Patch('/resetPassword')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async resetPassword(@Request() request, @Body() resetPasswordDto: ResetPasswordDto){
        this.logggerService.log('Patch /resetPassword',request.user.id);
        return this.providerService.resetPassword(request.user.email, resetPasswordDto)
    }

    @Post('/collection')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async createCollection(@Request() request,@Body() body){
        this.logggerService.log('POST /createContent',request.user.id);
        let provider_id = request.user.id
        this.logger.log("provider_id",provider_id)
        this.logger.log("body", body);
        return this.providerService.createCollection(provider_id, body)
    }

    @Get('/collection')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async getCollection(@Request() request){
        this.logggerService.log('POST /createContent',request.user.id);
        let provider_id = request.user.id
        this.logger.log("provider_id",provider_id)
        return this.providerService.getCollection(provider_id)
    }

    @Get('/collection/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async getCollectionContent(@Request() request, @Param('id') id){
        this.logggerService.log('POST /createContent',request.user.id);
        let provider_id = request.user.id
        this.logger.log("provider_id",provider_id)
        return this.providerService.getCollectionContent(id)
    }

    @Patch('/collection/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async updateCollection(@Request() request, @Param('id') id, @Body() body){
        this.logggerService.log('POST /updateCollection',request.user.id);
        let provider_id = request.user.id
        this.logger.log("provider_id",provider_id)
        this.logger.log("id",id)
        this.logger.log("body",body)
        return this.providerService.updateCollection(id, provider_id, body)
    }

    @Delete('/collection/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async deleteCollection(@Request() request, @Param('id') id){
        this.logggerService.log('POST /deleteCollection',request.user.id);
        let provider_id = request.user.id
        this.logger.log("provider_id",provider_id)
        this.logger.log("id",id)
        return this.providerService.deleteCollection(id, provider_id)
    }

    @Post('/contentCollection')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async createContentCollection(@Request() request,@Body() body){
        this.logggerService.log('POST /createCollectionContent',request.user.id);
        let provider_id = request.user.id
        this.logger.log("provider_id",provider_id)
        this.logger.log("body", body);
        return this.providerService.createContentCollection(body)
    }

    @Delete('/contentCollection/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async deleteContentCollection(@Request() request, @Param('id') id){
        this.logggerService.log('POST /deleteContentCollection',request.user.id);
        let provider_id = request.user.id
        this.logger.log("provider_id",provider_id)
        this.logger.log("id",id)
        return this.providerService.deleteContentCollection(id)
    }

    @Post('/createBulkContent1')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async createBulkContent(@Request() request, @Body() body){
        this.logggerService.log('POST /createBulkContent',request.user.id);
        let provider_id = request.user.id
        return this.providerService.createBulkContent(provider_id, body)
    }

    @Post('/createBulkContent')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    @UseInterceptors(FileInterceptor('file', {
        storage: diskStorage({
            destination: './files'
        })
    }))
    async uploadCSV(@UploadedFile() file: Express.Multer.File, @Request() request) {
        let provider_id = request.user.id
        const results = [];
        //this.logger.log('uploadCsv /upload API')
        return new Promise((resolve, reject) => {
            createReadStream(file.path)
                .pipe(csvParser())
                .on('data', (data) => {
                    results.push(data)
                }
                )
                .on('end', async () => {
                    const data = await this.providerService.createBulkContent(provider_id, results)
                    resolve(data)
                })
                .on('error', (error) => {
                    reject(error);
                })
        })

    }

    @Post('/uploadImage')
    @UseInterceptors(FileInterceptor('file'))
    async addFile(
        @UploadedFile() file: Express.Multer.File,
        @Body('document_type') document_type: string,
        
    ) {
        this.logger.log("upload-file", file)
        this.logger.log("document_type", document_type)
        return await this.providerService.addFile(file, document_type)
    }

    @Get('/getImageUrl/:id')
    @UseInterceptors(FileInterceptor('file'))
    async getFileUrl(
        @Param('id') id: string
    ) {
        this.logger.log("get-file id", id)
        return await this.providerService.getFile(id)
    }

    //scholarship
    @Post('/scholarship')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async createScholarship(@Request() request,@Body() scholarship?:ScholarshipDto){
        this.logger.log("user", request.user);
        this.logger.log("scholarship", scholarship);
        this.logggerService.log('POST /scholarship',request.user.id);
        let provider_id = request.user.id
        return this.providerService.createScholarship(provider_id, scholarship)
    }

    @Get('/scholarship')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async getScholarship(@Request() request){
        this.logger.log("user", request.user);
        this.logggerService.log('POST /scholarship',request.user.id);
        let provider_id = request.user.id
        return this.providerService.getScholarship(provider_id)
    }

    @Get('/scholarship/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async getScholarshipById(@Request() request, @Param('id') id){
        this.logger.log("user", request.user);
        this.logggerService.log('POST /scholarship',request.user.id);
        let provider_id = request.user.id
        return this.providerService.getScholarshipById(id, provider_id)
    }

    @Patch('/scholarship/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async editScholarshipById(@Request() request, @Param('id') id, @Body() scholarship?:ScholarshipDto){
        this.logger.log("user", request.user);
        this.logggerService.log('POST /scholarship',request.user.id);
        let provider_id = request.user.id
        return this.providerService.editScholarshipById(id, provider_id, scholarship)
    }

    @Post('/icarcontent')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("provider"))
    async createIcarConten(@Request() request,@Body() createKvkContentdto?:CreateIcarContentDto){
        this.logger.log("user", request.user);
        this.logger.log("createKvkContentdto", createKvkContentdto);
        this.logggerService.log('POST /createicarKvkContent',request.user.id);
        let id = request.user.id
        this.logger.log("id",id)
        return this.providerService.createIcarConten(id,createKvkContentdto)
    }

}
