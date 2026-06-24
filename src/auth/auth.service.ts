import { Injectable} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { LoggerService } from 'src/services/logger/logger.service';
import {CreateProviderDto} from '../dto/createProvider.dto'
import {CreateUserDto} from '../dto/createUser.dto'
import {HasuraService} from '../services/hasura/hasura.service'
import {EmailService} from '../services/email/email.service'
import * as bcrypt from 'bcrypt'
import { CreateSeekerDto } from 'src/dto/createSeeker.dto';


@Injectable()
export class AuthService {
    

    public smsKey = '13893kjefbekbkb'

    constructor(private readonly jwtService: JwtService,private readonly logger:LoggerService,private readonly hasuraService:HasuraService,private readonly emailService:EmailService) { }
    async validateUser(request){
        let result = await this.hasuraService.isUserApproved(request.email);
        this.logger.log(result,"result");
        return result;
    }
    async createUser (createUserDto){
        const user = new CreateUserDto();
        user.email=createUserDto.email
        if(createUserDto.role!=="seeker" || (createUserDto.role=="seeker" && createUserDto.password)){
            this.logger.log("if")
            user.password= await bcrypt.hash(createUserDto.password,10)
        }
        user.name=createUserDto.name
        user.role=createUserDto.role
        this.logger.log("user", user)
        
        const createUser = await this.hasuraService.createUser(user);

        if(createUser.role ==='provider'){
            let providerUser = new CreateProviderDto();
            providerUser.organization = createUserDto.organization
            providerUser.source_code = createUserDto.source_code;
            providerUser.user_id = createUser.id

            const response = await this.hasuraService.createProviderUser(providerUser);
            return response;
        }else if (createUser.role==='seeker'){
            let seeker = new CreateSeekerDto()
            // seeker.organization = createUserDto.organization
            // seeker.source_code = createUserDto.source_code
            seeker.age=createUserDto.age
            seeker.gender=createUserDto.gender
            seeker.phone=createUserDto.phone
            seeker.name=createUserDto.name
            seeker.email=createUserDto.email
            seeker.user_id = createUser.id
            const response = await this.hasuraService.createSeekerUser(seeker);
            return response;
        }
    }

    async createUserSeeker (createUserDto){
        const user = new CreateUserDto();
        user.email=createUserDto.email
        user.password= await bcrypt.hash(createUserDto.password,10)
        user.name=createUserDto.name
        user.role=createUserDto.role
        
        const createUser = await this.hasuraService.createUser(user);

        if(createUser.role ==='provider'){
            let providerUser = new CreateProviderDto();
            providerUser.organization = createUserDto.organization
            providerUser.source_code = createUserDto.source_code;
            providerUser.user_id = createUser.id

            const response = await this.hasuraService.createProviderUser(providerUser);
            return response;
        }else if (createUser.role==='seeker'){
            let seeker = new CreateSeekerDto()
            // seeker.organization = createUserDto.organization
            // seeker.source_code = createUserDto.source_code
            seeker.name=createUserDto.name
            seeker.email=createUserDto.email
            seeker.user_id = createUser.id
            this.logger.log("email",seeker.email)
            const response = await this.hasuraService.createSeekerUser(seeker);
            return response;
        }
    }


    async findOne(email){
        const user = await this.hasuraService.findOne(email)
        return user;
    }
    generateToken(payload): string {
        const plainObject = JSON.parse(JSON.stringify(payload))

        const token = this.jwtService.sign(plainObject, { expiresIn: 8640000 })
        if(!token){
                this.logger.log('POST /login','log in failed')
            } 
        return token
        }

    


}
