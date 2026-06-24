import { Injectable, UnauthorizedException } from "@nestjs/common";
import { PassportStrategy } from "@nestjs/passport";
import { ExtractJwt, Strategy } from "passport-jwt";
import { LoggerService } from '../services/logger/logger.service';


@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {

    constructor(private readonly logger: LoggerService) {
        super({
            jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
            ignoreExpiration: false,
            //secretOrKey: jwtConstants.secret,
            secretOrKey: "key"
        });
    }

    validate(payload: any): any {

        //this.logger.log("payload 20", payload)
        return payload
    }
}