<p align="center">
  <a href="http://nestjs.com/" target="blank"><img src="https://nestjs.com/img/logo-small.svg" width="200" alt="Nest Logo" /></a>
</p>

[circleci-image]: https://img.shields.io/circleci/build/github/nestjs/nest/master?token=abc123def456
[circleci-url]: https://circleci.com/gh/nestjs/nest

  <p align="center">A progressive <a href="http://nodejs.org" target="_blank">Node.js</a> framework for building efficient and scalable server-side applications.</p>
    <p align="center">
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/v/@nestjs/core.svg" alt="NPM Version" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/l/@nestjs/core.svg" alt="Package License" /></a>
<a href="https://www.npmjs.com/~nestjscore" target="_blank"><img src="https://img.shields.io/npm/dm/@nestjs/common.svg" alt="NPM Downloads" /></a>
<a href="https://circleci.com/gh/nestjs/nest" target="_blank"><img src="https://img.shields.io/circleci/build/github/nestjs/nest/master" alt="CircleCI" /></a>
<a href="https://coveralls.io/github/nestjs/nest?branch=master" target="_blank"><img src="https://coveralls.io/repos/github/nestjs/nest/badge.svg?branch=master#9" alt="Coverage" /></a>
<a href="https://discord.gg/G7Qnnhy" target="_blank"><img src="https://img.shields.io/badge/discord-online-brightgreen.svg" alt="Discord"/></a>
<a href="https://opencollective.com/nest#backer" target="_blank"><img src="https://opencollective.com/nest/backers/badge.svg" alt="Backers on Open Collective" /></a>
<a href="https://opencollective.com/nest#sponsor" target="_blank"><img src="https://opencollective.com/nest/sponsors/badge.svg" alt="Sponsors on Open Collective" /></a>
  <a href="https://paypal.me/kamilmysliwiec" target="_blank"><img src="https://img.shields.io/badge/Donate-PayPal-ff3f59.svg"/></a>
    <a href="https://opencollective.com/nest#sponsor"  target="_blank"><img src="https://img.shields.io/badge/Support%20us-Open%20Collective-41B883.svg" alt="Support us"></a>
  <a href="https://twitter.com/nestframework" target="_blank"><img src="https://img.shields.io/twitter/follow/nestframework.svg?style=social&label=Follow"></a>
</p>
  <!--[![Backers on Open Collective](https://opencollective.com/nest/backers/badge.svg)](https://opencollective.com/nest#backer)
  [![Sponsors on Open Collective](https://opencollective.com/nest/sponsors/badge.svg)](https://opencollective.com/nest#sponsor)-->

## Description

[Nest](https://github.com/nestjs/nest) framework TypeScript starter repository.

## Installation

```bash
$ npm install
```

## Running the app

```bash
# development
$ npm run start

# watch mode
$ npm run start:dev

# production mode
$ npm run start:prod
```

## Test

```bash
# unit tests
$ npm run test

# e2e tests
$ npm run test:e2e

# test coverage
$ npm run test:cov
```
## About

ICAR Reference App

Icar provider service is reference app for adding contents related to vistaar network. Provider can register themselves and add their contents to this app. Provider can create/read/update/delete their contents.

## API Integrations

### Kisan Help Center (KHC) grievances

The `khc-agri` provider supports new and existing farmers. Registration follows
**send OTP -> verify OTP -> collect/confirm grievance details -> create grievance**.
Status lookup asks only for the grievance number and does not require OTP.

Set these variables in the provider backend environment (not the browser):

```dotenv
KHC_BASE_URL=https://uat.dritm.com/khc/api/api
KHC_API_KEY=<key supplied securely by KHC>
```

The key is sent as `Authorization: ApiKey <key>`. Do not include the `ApiKey`
prefix in `KHC_API_KEY`. The UAT host sends real SMS; production requires a
separate base URL and key. No cookie copied from a browser is needed.

### KHC master data cache

Reference lists (states, districts, sub-districts, villages, schemes, categories,
sub-categories) are cached in Postgres. Lookups read the DB first and fall back to the
KHC API when a list is missing, older than 35 days, or the DB is down; stale data is
served if the API is also down. A monthly cron (1st of the month, 02:00 schemes/categories,
03:00 locations) keeps it warm.

Like the mandi cache, it needs no setup script: the `khc_*` tables are created at startup
in the database the provider already uses (`IMD_DB_*`). Nothing to configure; override
only if the cache should live elsewhere. Without DB settings everything still works
through the API.

```dotenv
# KHC_DB_HOST= KHC_DB_PORT= KHC_DB_NAME= KHC_DB_USER= KHC_DB_PASSWORD= KHC_DB_SSL=   (default: IMD_DB_*)
# KHC_MASTER_DB_ENABLED=false       # turn the cache off
# KHC_MASTER_MAX_AGE_DAYS=35        # how long a stored list is trusted by reads
# KHC_SYNC_REFRESH_DAYS=25          # the cron re-fetches lists older than this (keep below the cron gap)
# KHC_SYNC_ENABLED=false            # turn the cron off
# KHC_SYNC_ON_START=true            # seed once in the background after startup
# KHC_SYNC_GRIEVANCE_CRON="0 0 2 1 * *"   KHC_SYNC_LOCATION_CRON="0 0 3 1 * *"
# KHC_VILLAGE_BATCH=1000            # sub-districts whose villages load per monthly run
```

Two extra `/mobility/init` request types use the cache:

| `request_type` | Inputs | Result tag |
| --- | --- | --- |
| `find_location` | `name`; optional `state_name`/`state_id`, `district_name`/`district_id` | `khc_location`: matches with state, district, block and village ids; `needs` says what to ask next when nothing matched |
| `grievance_tree` | `state_name` or `state_id`; optional `scheme_name` | `khc_grievance_tree`: the state's schemes, or the named scheme's categories with sub-categories |

Villages not reached by the cron are cached the first time someone asks for them. To
run the DB tests: `KHC_TEST_DB_HOST=... KHC_TEST_DB_NAME=... KHC_TEST_DB_USER=...
KHC_TEST_DB_PASSWORD=... npx jest src/services/khc`.

Beckn requests use `provider.id = khc-agri`, item `khc-grievance`, and flat
`message.order.fulfillments[0].customer.person.tags`:

| Endpoint | `request_type` | Inputs |
| --- | --- | --- |
| `/mobility/init` | `get_otp` | `farmerMobileNumber` |
| `/mobility/init` | `verify_otp` | `farmerMobileNumber`, `otp` |
| `/mobility/init` | `get_reference` | `reference_type`, optional `parent_id`, `name`, `page` |
| `/mobility/init` | `create_grievance` | Verified mobile, creation fields below, `confirmed=true` |
| `/mobility/status` | Not required | `grievanceNo`, preserved with slashes/leading zeros |

Sending, verifying and creating must share `context.transaction_id`. Verification
is bound to that transaction and mobile, and expires locally after five minutes.
The verification response determines `isRegistered`; a caller cannot bypass the
new-farmer requirements by claiming to be registered. OTPs, upstream login tokens
and cookies are never echoed in Beckn responses. Login tokens are not retained:
the grievance API uses the API key; the provider separately enforces verified
mobile ownership. Resending OTP invalidates earlier local verification.

Verification state is in memory, like the existing AIF session store: restarting
requires a fresh OTP. Use Redis/shared state before deploying multiple replicas.

Creation fields are `externalReferenceNo`, `farmerMobileNumber`,
`farmerLanguage`, `stateId`, `villageId`, `scheme`, `division`,
`problemCategory`, `problemSubCategory`, and `farmerText`. New farmers additionally
require `farmerName` and `gender` (`M`, `F`, `O`). Existing farmers do not need those
details again. IDs are sent as numbers. State/village IDs are LGD codes, but choose
them through KHC's hierarchy. The grievance location may differ from home address.
The chat agent reuses a stated grievance location or, when available, permitted
browser coordinates via reverse geocoding and these reference APIs. Without usable
coordinates it asks for location details; coordinates are never treated as IDs.

Reference types: `states`; `districts` (parent state); `sub-districts` (district);
`villages` (sub-district); `schemes` (state); `categories` (scheme);
`sub-categories` (category). Pick `division` from the same scheme row. Reference
results can be filtered by name and are paged locally, 50 rows per page. No example
IDs are used as defaults. Upstream requests are not automatically retried.

Name filtering uses case-insensitive, whitespace-insensitive substring matching:
`uttarpradesh` matches `Uttar Pradesh`. Original names/IDs and all ambiguous
matches are preserved; no fuzzy spelling correction or ID guessing is used.

The chat tool derives a stable `externalReferenceNo` from the conversation and
confirmed grievance fields. Per the KHC guide, resending the same reference returns
the existing grievance instead of creating another. After a timeout or malformed
creation response, do not blindly submit a new reference; verify with KHC first.

Status is sent upstream as
`GET /v1/state/grievances/status?grievanceNo=<encoded number>`, not as a header.
Successful results include the grievance number, status, current level and date
when provided. A missing grievance is an explicit `not_found` result.

Run focused tests:

```bash
npm test -- --runInBand --runTestsByPath src/services/khc/khc.service.spec.ts
```

This service includes the following API integrations:

- **PM Kisan Installment Check** - Check PM Kisan installment status and beneficiary details
- **Scheme Information** - Retrieve information about various agricultural schemes
- **PMFBY Status Check** - Check Pradhan Mantri Fasal Bima Yojana (PMFBY) policy and claim status
- **Weather Forecast** - Get weather forecast data from IMD (Indian Meteorological Department) based on GPS coordinates
- **Grievance** - Handle and process grievance-related requests

### AgriStack synchronous DPE gateway

Categories A/B/C use `https://ufsi.agristack.gov.in/gateway/seek`. Beckn search item
tags must include `farmerId` and `stateLgdCode` from the consented login callback;
B/C also require `season` and `year`. The provider sends the state as
`X-State-LGD-Code` and sends exactly `frCentralId` (A) or
`frCentralId`, `season`, `year` (B/C) in `query_param`.

Configure these environment variables:

- `AGRISTACK_USERNAME`, `AGRISTACK_PASSWORD`: onboarded token credentials.
- `AGRISTACK_SENDER_ID`: onboarded AIU identifier.
- `AGRISTACK_PRIVATE_KEY_PATH`: path to a securely mounted RSA private-key PEM.
  Defaults to `private_key.pem` relative to the server working directory.
  Containers must mount the file at runtime; key files are excluded from the
  Docker build context.
- Optional overrides: `AGRISTACK_TOKEN_URL`, `AGRISTACK_CLIENT_ID`,
  `AGRISTACK_SEEK_URL`, `AGRISTACK_RECEIVER_ID`, `AGRISTACK_SIGNATURE`,
  `AGRISTACK_SERVICE_ID_CATEGORY_A`, `AGRISTACK_SERVICE_ID_CATEGORY_B`,
  `AGRISTACK_SERVICE_ID_CATEGORY_C`. Receiver ID and signature default to empty.
  Remove any old state-specific `AGRISTACK_SEEK_URL` override when migrating.

Register the **matching** RSA public key (X.509 SubjectPublicKeyInfo, at least
2048 bits) against the sender ID with AgriStack. The public key is used upstream
to encrypt, not locally to decrypt. Keep the private key server-side, restrict its
file permissions, and never commit key files. The provider unwraps `encrypted_key`
with RSA-OAEP/SHA-256, then decrypts `encrypted_data` with AES-256-GCM and verifies
`auth_tag` before parsing the returned array. Unsupported encryption, malformed
payloads, missing/wrong keys and authentication failures return an error catalog;
they do not return a success-shaped empty result. Audits retain encrypted response
envelopes rather than decrypted farmer records.

Run focused tests:
`npm test -- --runInBand --runTestsByPath src/services/agristack/agristack.service.spec.ts`.

Steps to install this app.

1. Git clone https://github.com/tekdi/icar-provider-service.git

2. cd icar-provider-service

3. npm install

4. npm run start

5. run http://localhost:3000 on your browser to test the app is running

6. Copy `.env.example` to `.env` and update the values:

```bash
cp .env.example .env
```

Then edit `.env` file with your actual configuration values. See `.env.example` for all required environment variables including:

- Hasura Configuration
- AWS S3 Configuration
- Database Configuration (for Weather Forecast)
- API Keys and Tokens
- Email Service Configuration

7. Restart the server: npm run start
