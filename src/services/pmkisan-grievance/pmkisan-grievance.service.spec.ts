import axios from 'axios';
import * as crypto from 'crypto';
import { PmkisanGrievanceService } from './pmkisan-grievance.service';
import { LoggerService } from '../logger/logger.service';
import { trackExternalApiCall } from '../../telemetry/ext-api-call.tracker';

jest.mock('axios');
jest.mock('../../telemetry/ext-api-call.tracker', () => ({
  ...jest.requireActual('../../telemetry/ext-api-call.tracker'),
  trackExternalApiCall: jest.fn(),
}));

const mockedRequest = axios.request as jest.Mock;
const mockedTrack = trackExternalApiCall as jest.Mock;

const KEY = crypto.randomBytes(32);
const NONCE = crypto.randomBytes(12);

function encryptedOutput(value: any): any {
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, NONCE);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return { d: { output: Buffer.concat([ciphertext, cipher.getAuthTag()]).toString('base64') } };
}

function statusBody(person: any) {
  return {
    context: { action: 'search', transaction_id: 'txn-1', message_id: 'msg-1' },
    message: { intent: { order: { fulfillments: [{ customer: { person } }] } } },
  };
}

const REG_PERSON = {
  tags: [{ descriptor: { code: 'reg-details' }, list: [{ descriptor: { code: 'reg-number' }, value: 'UP123456789' }] }],
};
const AADHAAR_PERSON = {
  tags: [{ descriptor: { code: 'reg-details' }, list: [{ descriptor: { code: 'aad-number' }, value: '123412341234' }] }],
};

describe('PmkisanGrievanceService telemetry', () => {
  const env = process.env;
  let service: PmkisanGrievanceService;

  beforeEach(() => {
    process.env = {
      ...env,
      GRIEVANCE_KEY_1: KEY.toString('hex'),
      GRIEVANCE_KEY_2: NONCE.toString('hex'),
      PMKISAN_GRIEVANCE_BASE_URL: 'https://grievance.test',
    };
    mockedRequest.mockReset();
    mockedTrack.mockReset();
    service = new PmkisanGrievanceService(new LoggerService());
  });

  afterEach(() => {
    process.env = env;
  });

  it('records a successful status check', async () => {
    mockedRequest.mockResolvedValue({
      status: 200,
      data: encryptedOutput({ Responce: 'True', details: [{ GrievanceStatus: 'Open' }] }),
    });

    await service.searchGrievanceStatus(statusBody(REG_PERSON));

    expect(mockedTrack).toHaveBeenCalledTimes(1);
    expect(mockedTrack.mock.calls[0][0]).toMatchObject({
      apiService: 'pmkisan_grievance_status',
      url: 'https://grievance.test/GrievanceStatusCheck',
      outcome: 'success',
      statusCode: 200,
      identifierType: 'Reg_No_Status',
    });
    expect(mockedRequest.mock.calls[0][0].skipTelemetry).toBe(true);
  });

  it('records a refused status check as rejected', async () => {
    mockedRequest.mockResolvedValue({
      status: 200,
      data: encryptedOutput({ Responce: 'False', Message: 'No grievance found' }),
    });

    await service.searchGrievanceStatus(statusBody(REG_PERSON));

    expect(mockedTrack.mock.calls[0][0]).toMatchObject({
      outcome: 'rejected',
      upstreamMessage: 'No grievance found',
    });
  });

  it('records a missing Aadhaar token as rejected and skips the status call', async () => {
    mockedRequest.mockResolvedValue({ status: 200, data: encryptedOutput({ message: 'Invalid Aadhaar' }) });

    await service.searchGrievanceStatus(statusBody(AADHAAR_PERSON));

    expect(mockedTrack).toHaveBeenCalledTimes(1);
    expect(mockedTrack.mock.calls[0][0]).toMatchObject({
      apiService: 'pmkisan_grievance_aadhaar_token',
      outcome: 'rejected',
      upstreamMessage: 'Invalid Aadhaar',
    });
  });

  it('records a timeout as error and keeps the existing failure response', async () => {
    mockedRequest.mockRejectedValue(Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' }));

    const response = await service.createGrievance(statusBody(REG_PERSON));

    expect(mockedTrack.mock.calls[0][0]).toMatchObject({
      apiService: 'pmkisan_grievance_lodge',
      outcome: 'error',
      errorType: 'timeout',
      statusCode: null,
    });
    const status = response.message.order.tags[0].list.find((i: any) => i.descriptor.code === 'status');
    expect(status.value).toBe('Failed');
  });
});
