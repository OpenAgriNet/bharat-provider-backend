import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { HasuraService } from '../services/hasura/hasura.service'
import { CreateContentDto } from 'src/dto/createContent.dto';
import * as bcrypt from "bcrypt"
import { S3Service } from 'src/services/s3/s3.service';
import { LoggerService } from '../services/logger/logger.service';

@Injectable()
export class ProviderService {

    constructor(private readonly hasuraService: HasuraService, private readonly s3Service: S3Service, private readonly logger: LoggerService) { }
    async createContent(id, createContentdto) {
        return this.hasuraService.createContent(id, createContentdto)
    }

    async getContent(id) {
        return this.hasuraService.getContent(id)
    }

    async getContentById(id, provider_id) {
        return this.hasuraService.getContentById(id, provider_id)
    }

    async editContent(id, createContentdto) {
        return this.hasuraService.editContent(id, createContentdto)
    }

    async deleteContent(id, provider_id) {
        return this.hasuraService.deleteContent(id, provider_id)
    }

    async resetPassword(email, resetPasswordDto) {
        this.logger.log("email", email)
        this.logger.log("resetPasswordDto", resetPasswordDto)
        const user = await this.hasuraService.findOne(email)
        if (user) {
            const passwordMatches = await bcrypt.compare(resetPasswordDto.currentPassword, user.password);
            if (passwordMatches) {
                const newPassword = await bcrypt.hash(resetPasswordDto.newPassword, 10)
                return this.hasuraService.updatePassword(user.id, newPassword)

            } else {
                throw new HttpException('Password is incorrect!', HttpStatus.UNAUTHORIZED);
            }

        }
    }

    async createCollection(provider_id, body) {
        return this.hasuraService.createCollection(provider_id, body)
    }

    async getCollection(provider_id) {
        return this.hasuraService.getCollection(provider_id)
    }

    async getCollectionContent(id) {
        return this.hasuraService.getCollectionContent(id)
    }

    async updateCollection(id, provider_id, body) {
        return this.hasuraService.updateCollection(id, provider_id, body)
    }

    async deleteCollection(id, provider_id) {
        return this.hasuraService.deleteCollection(id, provider_id)
    }

    async createContentCollection(body) {
        return this.hasuraService.createContentCollection(body)
    }

    async deleteContentCollection(id) {
        return this.hasuraService.deleteContentCollection(id)
    }

    async createBulkContent1(provider_id, data) {
        return this.hasuraService.createBulkContent(provider_id, data)
    }

    async createBulkContent(provider_id, result) {
        
        const expectedHeaders = ['content id', 'Name', 'Description', 'Icon', 'Crop', 'Branch', 'Publisher', 'Collection', 'URL_Type', 'URL', 'Mime_Type', 'Language', 'Content Type', 'Category', 'Themes', 'Min age', 'Max age', 'Author', 'Domain', 'Curricular Goals', 'Competencies', 'Learning Outomes', 'District', 'State', 'Expiry Date', 'File Type', 'Month Or Season', 'Publish Date', 'Region', 'Target Users'  ];
        const csvheader = Object.keys(result[0])
        const areHeadersValid = this.arraysHaveSameElements(expectedHeaders, csvheader)
        // const areHeadersValid = expectedHeaders.every((expectedHeader) => {
        //     return csvheader.includes(expectedHeader);
        // })
        const updates = [];

        if (true) {
            for (const log of result) {
                updates.push({
                    user_id: provider_id,
                    content_id: log['content id'],
                    title: log['Name'],
                    contentType: log['Content Type'],
                    crop: log['Crop'],
                    description: log['Description'],
                    expiryDate: log['Expiry Date'],
                    fileType: log['File Type'],
                    monthOrSeason: log['Month Or Season'],
                    publishDate: log['Publish Date'],
                    publisher: log['Publisher'],
                    region: log['Region'],
                    state: log['State'],
                    target_users: log['Target Users'],
                    url: log['URL'],
                    branch: log['Branch'],
                    language: log['Language'],
                    icon: log['Icon']

                })

            }
            //return updates
            const promises = []
            updates.forEach((item) => {
                promises.push(this.hasuraService.createContent(provider_id, item))
            })

            return await Promise.all(promises)

        } else {
            return {
                error: "Invalid CSV headers"
            }
        }

        // if (true) {
        //     for (const log of result) {
        //         updates.push({
        //             user_id: provider_id,
        //             content_id: log['content id'],
        //             title: log['Name'] ?? null,
        //             description: log['Description'] ?? null,
        //             icon: log['Icon'] ?? null,
        //             crop: log['Crop'] ?? null,
        //             branch: log['Branch'] ?? null,
        //             publisher: log['Publisher'] ?? null,
        //             // collection: log['Collection'] ?? null,
        //             // urlType: log['URL_Type'] ?? null,
        //             url: log['URL'] ?? null,
        //             //mimeType: log['Mime_Type'] ?? null,
        //             language: log['Language'] ?? null,
        //             contentType: log['Content Type'] ?? null,
        //             //category: log['Category'] ?? null,
        //             //themes: log['Themes'] ?? null,
        //             // minAge: parseInt(log['Min age']),
        //             // maxAge: parseInt(log['Max age']),
        //             // author: log['Author'] ?? null,
        //             // domain: log['Domain'] ?? null,
        //             // goal: log['Curricular Goals'] ?? null,
        //             // competency: log['Competencies'] ?? null,
        //             // learningOutcomes: log['Learning Outomes'] ?? null,
        //             //district: log['District'] ?? null,
        //             state: log['State'] ?? null,
        //             expiryDate: log['Expiry Date'] ?? null,
        //             //fileType: log['File Type'] ?? null,
        //             monthOrSeason: log['Month Or Season'] ?? null,
        //             publishDate: log['Publish Date'] ?? null,
        //             region: log['Region'] ?? null,
        //             target_users: log['Target Users'] ?? null

        //         })

        //     }
        //     //return updates
        //     const promises = []
        //     updates.forEach((item) => {
        //         promises.push(this.hasuraService.createContent(provider_id, item))
        //     })

        //     return await Promise.all(promises)

        // } else {
        //     return {
        //         error: "Invalid CSV headers"
        //     }
        // }
    }

    arraysHaveSameElements(arr1, arr2) {
        if (arr1.length !== arr2.length) {
            return false; // Arrays have different lengths, so they can't be the same
        }
        return arr1.every((element) => arr2.includes(element)) &&
            arr2.every((element) => arr1.includes(element));
    }

    async addFile(file: Express.Multer.File, document_type: string) {
        
        const originalName = file.originalname.split(" ").join("").toLowerCase()
        const [name, fileType] = originalName.split(".")
        let key = `${name}${Date.now()}.${fileType}`;
        this.logger.log("key", key)
        const imageUrl = await this.s3Service.uploadFile(file, key);
        this.logger.log("imageUrl", imageUrl)
        return {imageUrl: imageUrl, mimetype: `image/${fileType}`, key: key}
        
    }

    async getFile(id: string) {
        const key = id;
        return await this.s3Service.getFileUrl(key);
    }

    //Scholarship
    async createScholarship(provider_id, scholarship) {
        return this.hasuraService.createScholarship(provider_id, scholarship)
    }

    async getScholarship(provider_id) {
        return this.hasuraService.getScholarship(provider_id)
    }

    async getScholarshipById(id, provider_id) {
        return this.hasuraService.getScholarshipById(id, provider_id)
    }

    async editScholarshipById(id, provider_id, scholarship) {
        return this.hasuraService.editScholarshipById(id, provider_id, scholarship)
    }

    async createIcarConten(id, createIcarContentdto) {
        return this.hasuraService.createIcarContent(id, createIcarContentdto)
    }
}
