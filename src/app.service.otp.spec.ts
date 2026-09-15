import { AppService } from "./app.service";
import { LoggerService } from "./services/logger/logger.service";

/**
 * Regression test for the PM-KISAN grievance/status OTP bypass: handleOtpValidation
 * used to skip verifyOTP entirely and accept any 4-digit value as a valid OTP.
 */
describe("AppService.handleOtpValidation (PM-KISAN OTP verification)", () => {
    let service: AppService;
    let logger: LoggerService;

    const stub = {} as any;

    beforeEach(() => {
        logger = { log: jest.fn(), error: jest.fn(), warn: jest.fn() } as any;
        service = new AppService(
            stub,
            stub,
            stub,
            logger,
            stub,
            stub,
            stub,
            stub,
            stub,
            stub,
            stub,
        );
    });

    const bodyFor = (orderId: string, regNumber: string) => ({
        context: { transaction_id: "tx-1" },
        message: { order_id: orderId, registration_number: regNumber },
    });

    it("rejects the request when verifyOTP reports the OTP is invalid", async () => {
        jest.spyOn(service as any, "verifyOTP").mockResolvedValue({ status: "NOT_OK" });
        const fetchUserDataSpy = jest
            .spyOn(service as any, "fetchUserData")
            .mockResolvedValue("should not be called");

        const result: any = await service.handleStatus(bodyFor("1234", "123456789012"));

        expect(result.message.order.tags[0].descriptor.code).toBe("invalid_otp");
        expect(fetchUserDataSpy).not.toHaveBeenCalled();
    });

    it("proceeds to fetch user data only when verifyOTP confirms the OTP is correct", async () => {
        jest.spyOn(service as any, "verifyOTP").mockResolvedValue({ status: "OK" });
        jest
            .spyOn(service as any, "fetchUserData")
            .mockResolvedValue("Beneficiary Name - Test Farmer");

        const result: any = await service.handleStatus(bodyFor("1234", "123456789012"));

        expect(result.message.order.state).toBe("COMPLETED");
    });
});
