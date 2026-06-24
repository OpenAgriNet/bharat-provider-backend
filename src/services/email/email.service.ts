import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UtilService } from './utility'
import { LoggerService } from 'src/services/logger/logger.service';
const nodemailer = require("nodemailer");
const formData = require('form-data');
const Mailgun = require('mailgun.js');
const axios = require('axios');

@Injectable()
export class EmailService {
  private aws_host = process.env.AWS_HOST;
  private aws_user = process.env.AWS_USER;
  private aws_pass = process.env.AWS_PASS;
  public mailgun_apikey = process.env.MAILGUN_APIKEY
  private mailgun_url = process.env.MAILGUN_URL
  private mailgun_sender = process.env.MAILGUN_SENDER


  constructor(
    private readonly utilService: UtilService,
    private configService: ConfigService,
    private readonly logger:LoggerService
  ) { }

  async sendWelcomeEmail1(email: string): Promise<string> {
    this.logger.log("email", email)

    let transporter = nodemailer.createTransport({
      host: this.aws_host,
      port: 587,
      secure: false, // true for 465, false for other ports
      auth: {
        user: this.aws_user,
        pass: this.aws_pass,
      },
      tls: {
        rejectUnauthorized: false
      },
    });


    // send mail with defined transport object
    let emailData = {};

    emailData = {
      from: `"Manipal" <abhilash.dube@tekditechnologies.com>`, // sender address
      to: email, // list of receivers
      subject: `Manipal sa-dashboard`, // Subject line
      text: `Email from manipal sa-dashboard`, // plain text body
      //html: "<b>Hello world?</b>", // html body
    }
    try {
      let info = await transporter.sendMail(emailData);
      this.logger.log("info", info)
      if (info.messageId) {
        this.logger.log("email sent!")
        return "Email sent successfully!"
      } else {
        this.logger.log("unable to send email")
        return "unable to send email"
      }
    } catch (error) {
      this.logger.log("email err", error)
      throw new HttpException('Unable to send Email!', HttpStatus.INTERNAL_SERVER_ERROR);
    }


  }

  generateRefCode(email: string) {
    const referralCode = this.utilService.generateReferralCode(email);
    this.logger.log('Referral Code Generated')
    return referralCode
  }

  sendEmail1() {

    this.logger.log("Send email function...")
    const main = async () => {

      let transporter = nodemailer.createTransport({
        host: this.aws_host,
        port: 587,
        secure: false, // true for 465, false for other ports
        auth: {
          user: this.aws_user,
          pass: this.aws_pass,
        },
        tls: {
          rejectUnauthorized: false
        },
      });


      // send mail with defined transport object
      let emailData = {};

      emailData = {
        from: `"Manipal" <abhilash.dube@tekditechnologies.com>`, // sender address
        to: `suraj_k@tekditechnologies.com`, // list of receivers
        //to: `suraj_k@tekditechnologies.com`,
        subject: `Manipal sa-dashboard`, // Subject line
        text: `Email from manipal sa-dashboard`, // plain text body
        //html: "<b>Hello world?</b>", // html body
      }

      let info = await transporter.sendMail(emailData);

      if (info.messageId) {
        this.logger.log("email sent!")
        return "Email sent successfully!"
      } else {
        this.logger.log("unable to send email")
        return "unable to send email"
      }




    }
    main().catch((error) =>
      this.logger.error(
        "Email send failed",
        error instanceof Error ? error.stack ?? error.message : String(error),
      ),
    );


  }

  async sendRequestedUserEmail(payload) {

    let subject = 'Request For Student Ambassdor'

    let text = `
    <!DOCTYPE html>
    <html>
    <head>
        <title>Welcome to Medace</title>
    </head>
    <body>
    <p>Hello Manipal,</p>

    <p>Please be informed that there is a request from a student to become a Student Ambassador. Please log in to the Portal and kindly approve the application.</p>

    <p>Thanks,<br>Team Manipal MedAce</p>
    </body>
    </html>
    `;


    this.sendEmail("mongodb4038@gmail.com", subject, text)

  }


  async sendWelcomeEmail(email: string, name: string, mobile: string, referralCode: string) {

    let subject = 'Welcome to Medace'

    let text = `
    <!DOCTYPE html>
<html>
<head>
    <title>Welcome to Medace</title>
</head>
<body>
    <p>Hello ${name},</p>

    <p>We are thrilled to welcome you to the MedAcers team at Manipal MedAce! Congratulations on your selection, and we are excited to have you join us on this incredible journey dedicated to making a positive impact in the life of an MBBS student.</p>

    <p>At MedAce, we believe in the power of innovation and collaboration to transform healthcare. Your selection reflects our confidence in your abilities and your potential to contribute significantly to our mission. We are confident that your skills, dedication, and enthusiasm will be valuable assets to our team.</p>

    <p>Your dedicated Area Manager will reach out to you and share your Roles and Responsibilities that you need to carry out in your assigned college/territory during this entire journey.</p>

    <p>We have activated your MedAcers Dashboard, where you can see all the program details, your profile, your contribution, achievements & more.</p>

    <p>You can log in to the MedAcers Dashboard using your phone number listed below:</p>

    <p>Portal Link: <a href="https://medacers.manipalmedace.com/">Click here</a></p>

    <p>Phone Number: <a href="tel:${mobile}">${mobile}</a></p>
    
    <p>Your Referral Code: ${referralCode}</p>

    <p>For any queries, please reach out to your dedicated area manager or contact us at +91 81 5183 5183 | support@manipalmedace.com.</p>

    <p>We look forward to applauding you and celebrating your successes as we are #InThisTogether.</p>

    <p>Thanks,<br>Team Manipal MedAce</p>
</body>
</html>

    `;

    return this.sendEmail(email, subject, text)

  }

  // async sendWelcomeEmail2(email: string, name: string) {
  //   this.logger.log("welcome email 198", email, name)

  //   let subject = 'Welcome to Medace'

  //   let text = `
  //   <!DOCTYPE html>
  //   <html>
  //   <head>
  //       <title>Welcome to Medace</title>
  //   </head>
  //   <body>
  //   <p>Hello ${name},</p>

  //   <p>We are thrilled to welcome you to the MedAcers team at Manipal MedAce! Congratulations
  //       on your selection, and we are excited to have you join us on this incredible journey
  //       dedicated to making a positive impact in the life of an MBBS student.</p>

  //   <p>At MedAce, we believe in the power of innovation and collaboration to transform
  //       healthcare. Your selection reflects our confidence in your abilities and your potential to
  //       contribute significantly to our mission. We are confident that your skills, dedication, and
  //       enthusiasm will be valuable assets to our team.</p>

  //   <p>Your dedicated Area Manager will reach out to you and share your Roles and
  //       Responsibilities that you need to carry out in your assigned college/territory during this
  //       entire journey.</p>

  //   <p>We have activated your MedAcers Dashboard, where you can see all the program details,
  //       your profile, your contribution, achievements & more.</p>

  //   <p>You can log in to the MedAcers Dashboard using the following credentials:</p>

  //   <p>Portal Link: <a href="https://medacers.manipalmedace.com/">Click here</a></p>

  //   <p>Contact Number: <a href="tel:+918151835183">+91 81-5183-5183</a></p>

  //   <p>For any queries, please reach out to your dedicated area manager or write to us at (Support Email ID/Contact Number).</p>

  //   <p>We look forward to applauding you and celebrating your successes as we are #InThisTogether.</p>

  //   <p>Thanks,<br>Team Manipal MedAce</p>
  //   </body>
  //   </html>
  //   `;

  //   return this.sendEmail2(email, subject, text)

  // }

  async sendEmail2(email, subject, text) {
    this.logger.log("email", email)
    this.logger.log("subject", subject)
    //this.logger.log("text", text)

    const api_key = this.configService.get<string>('MAILGUN_APIKEY')

    this.logger.log("api_key 255", api_key)

    const mailgun = new Mailgun(formData);
    const mg = mailgun.client({
      username: 'api',
      key: this.configService.get<string>('MAILGUN_APIKEY'),
    });

    try {
      let msg = await mg.messages
        .create('manipalmedace.com', {
          from: 'Manipal MedAce  <medacers@manipalmedace.com>',
          to: [email],
          subject: subject,
          html: text,
        })
      this.logger.log("msg 265", msg)
      return msg
    } catch (error) {
      this.logger.log("error", error)
      throw new HttpException(error, HttpStatus.INTERNAL_SERVER_ERROR);
    }

  }

  async sendEmail3(email, subject, text): Promise<any> {
    this.logger.log("sendEmail3")
    this.logger.log("email", email)
    this.logger.log("subject", subject)
    this.logger.log("text", text)

    const username = 'api'
    const password = this.mailgun_apikey

    const base64Credentials = Buffer.from(`${username}:${password}`).toString('base64');
    this.logger.log("base64Credentials", base64Credentials)


    let data = new formData();
    data.append('from', 'Manipal MedAcers medacers@manipalmedace.com');
    data.append('to', 'suraj_k@tekditechnologies.com');
    data.append('subject', 'Hello');
    data.append('text', 'Testing2 some Mailgun awesomeness!');

    let config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://api.mailgun.net/v3/manipalmedace.com/messages',
      headers: {
        'Authorization': `Basic ${base64Credentials}`,
        ...data.getHeaders()
      },
      data: data
    };
    try {
      let res = await axios.request(config)
      this.logger.log("msg", res.data)
      return res.data
    } catch (error) {

      this.logger.log("error", error);
      throw new HttpException(error, HttpStatus.INTERNAL_SERVER_ERROR);

    }

    // .then((response) => {
    //   this.logger.log(JSON.stringify(response.data));
    //   return response.data
    // })
    // .catch((error) => {
    //   this.logger.log(error);
    //   throw new HttpException(error, HttpStatus.INTERNAL_SERVER_ERROR);
    // });


  }

  async sendEmail(email, subject, text) {
    this.logger.log("sendEmail 256")
    const axios = require('axios');
    const FormData = require('form-data');
    let data = new FormData();
    data.append('from', 'Manipal MedAcers medacers@manipalmedace.com');
    data.append('to', `${email}`);
    data.append('subject', `${subject}`);
    data.append('html', `${text}`);

    let config = {
      method: 'post',
      maxBodyLength: Infinity,
      url: 'https://api.mailgun.net/v3/manipalmedace.com/messages',
      headers: {
        'Authorization': 'Basic YXBpOjA2NGY0ZmE3Y2UzZWIyMWEwYTNhYmY2Mzk1ZDA3YTc1LTdjYTE0NGQyLTkwZjUxNDA4',
        ...data.getHeaders()
      },
      data: data
    };

    try {
      let res = await axios.request(config)
      this.logger.log("msg", res.data)
      return res.data
    } catch (error) {
      this.logger.log("error", error);
      throw new HttpException(error, HttpStatus.INTERNAL_SERVER_ERROR);
    }


  }


}
