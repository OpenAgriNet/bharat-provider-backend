import { Body, Controller, Patch, UseGuards, Request, Post, Delete, Param, Get } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { CreateContentDto } from 'src/dto/createContent.dto';
import { CreateSeekerDto } from 'src/dto/createSeeker.dto';
import { ResetPasswordDto } from 'src/dto/resetPassword.dto';
import { RoleGuard } from 'src/role.guard';
import { LoggerService } from 'src/services/logger/logger.service';
import { SeekerService } from './seeker.service';

@Controller('seeker')
export class SeekerController {

    constructor(private readonly seekerService:SeekerService, private readonly logggerService:LoggerService, private readonly logger: LoggerService) {}

    @Patch('/resetPassword')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async resetPassword(@Request() request, @Body() resetPasswordDto: ResetPasswordDto){
        this.logggerService.log('Patch /resetPassword',request.user.id);
        return this.seekerService.resetPassword(request.user.email, resetPasswordDto)
    }

    @Post('/searchContent')
    async getContent(@Request() request,@Body() getContentdto?:CreateContentDto){
        this.logger.log("getContentdto", getContentdto);
        this.logggerService.log('POST /getContent');
        return this.seekerService.getContent(getContentdto)
    }

    @Post('/searchCollection')
    async searchCollection(@Request() request,@Body() body){
        this.logger.log("getCollectionDto", body);
        this.logggerService.log('POST /getCollection');
        return this.seekerService.searchCollection(body)
    }

    @Post('/searchScholarship')
    async getScholarship(@Request() request,@Body() body){
        this.logggerService.log('POST /getScholarship');
        return this.seekerService.getScholarship(body)
    }

    @Post('/bookmarkContent')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async createContentBookmark(@Request() request,@Body() createContentdto?:CreateContentDto){
        this.logger.log("user", request.user);
        this.logger.log("createContentdto", createContentdto);
        this.logggerService.log('POST /createContent',request.user.id);
        let id = request.user.id
        this.logger.log("id",id)
        return this.seekerService.createContentBookmark(id,createContentdto)
    }

    @Delete('/bookmarkContent/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async removeBookmarkContent(@Request() request, @Param('id') id){
        this.logger.log("user", request.user);
        this.logggerService.log('POST /createContent',request.user.id);
        let seeker_id = request.user.id
        this.logger.log("id",id)
        return this.seekerService.removeBookmarkContent(id, seeker_id)
    }

    // @Get('/bookmarkContent')
    // @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    // async getBookmarkContent(@Request() request){
    //     this.logger.log("user", request.user);
    //     this.logggerService.log('POST /createContent',request.user.id);
    //     let seeker_id = request.user.id
    //     return this.seekerService.getBookmarkContent(seeker_id)
    // }

    @Get('/collection')
    async getCollection(@Request() request){
        return this.seekerService.getCollection()
    }

    @Get('/collection/:id')
    async getCollectionContent(@Request() request, @Param('id') id){
        return this.seekerService.getCollectionContent(id)
    }


    ////////////////
    @Post('/bookmark')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async createBookmark(@Request() request,@Body() body){
        this.logggerService.log('POST /createBookmark',request.user.id);
        let seeker_id = request.user.id
        this.logger.log("seeker_id",seeker_id)
        this.logger.log("body", body);
        return this.seekerService.createBookmark(seeker_id, body)
    }

    @Get('/bookmark')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async getBookmark(@Request() request){
        this.logggerService.log('POST /getBookmark',request.user.id);
        let seeker_id = request.user.id
        this.logger.log("seeker_id",seeker_id)
        return this.seekerService.getBookmark(seeker_id)
    }

    @Get('/bookmark/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async getBookmarkContent(@Request() request, @Param('id') id){
        this.logggerService.log('POST /getBookmarkContent',request.user.id);
        let seeker_id = request.user.id
        this.logger.log("seeker_id",seeker_id)
        return this.seekerService.getBookmarkContent(id, seeker_id)
    }

    @Patch('/bookmark/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async updateBookmark(@Request() request, @Param('id') id, @Body() body){
        this.logggerService.log('POST /updateBookmark',request.user.id);
        let seeker_id = request.user.id
        this.logger.log("seeker_id",seeker_id)
        this.logger.log("id",id)
        this.logger.log("body",body)
        return this.seekerService.updateBookmark(id, seeker_id, body)
    }

    @Delete('/bookmark/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async deleteCollection(@Request() request, @Param('id') id){
        this.logggerService.log('POST /deleteCollection',request.user.id);
        let seeker_id = request.user.id
        this.logger.log("seeker_id",seeker_id)
        this.logger.log("id",id)
        return this.seekerService.deleteBookmark(id, seeker_id)
    }

    @Post('/contentBookmark')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async addContentBookmark(@Request() request,@Body() body){
        this.logggerService.log('POST /addContentBookmark',request.user.id);
        let seeker_id = request.user.id
        this.logger.log("seeker_id",seeker_id)
        this.logger.log("body", body);
        return this.seekerService.addContentBookmark(body)
    }

    @Delete('/contentBookmark/:id')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async deleteContentBookmark(@Request() request, @Param('id') id){
        this.logggerService.log('POST /deleteContentBookmark',request.user.id);
        let seeker_id = request.user.id
        this.logger.log("seeker_id",seeker_id)
        this.logger.log("id",id)
        return this.seekerService.deleteContentBookmark(id, seeker_id)
    }

    //site-configuration
    @Post('/configuration')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async createConfig(@Request() request,@Body() createSeekerDto:CreateSeekerDto){
        this.logger.log("user", request.user);
        this.logggerService.log('POST /createConfig',request.user.id);
        let user_id = request.user.id
        return this.seekerService.createConfig(user_id,createSeekerDto)
    }

    @Get('/configuration')
    @UseGuards(AuthGuard("jwt"), new RoleGuard("seeker"))
    async getConfig(@Request() request){
        this.logger.log("user", request.user);
        this.logggerService.log('POST /createConfig',request.user.id);
        let user_id = request.user.id
        return this.seekerService.getConfig(user_id)
    }
    
}
