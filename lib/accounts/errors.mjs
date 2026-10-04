import { CommandError } from '../errors.mjs';

const MESSAGES = Object.freeze({
  ZUKU_LOGIN_REQUIRED: 'zukujs login zuku로 ZUKU 계정을 연결하세요.',
  ZUKU_AUTH_UNAVAILABLE: 'ZUKU 계정 연결 서비스를 사용할 수 없습니다. 잠시 후 다시 시도하세요.',
  ZUKU_AUTH_RESPONSE_INVALID: 'ZUKU 계정 연결 응답을 확인하지 못했습니다.',
  ZUKU_AUTH_DENIED: '브라우저에서 계정 연결을 거절했습니다.',
  ZUKU_AUTH_EXPIRED: '계정 연결 시간이 끝났습니다. 로그인을 다시 시작하세요.',
  ZUKU_ACCOUNT_UNSAFE: '계정 저장 위치의 소유권과 접근 권한을 확인하세요.',
  ZUKU_ACCOUNT_BUSY: '다른 ZukuJS 작업이 계정 정보를 갱신 중입니다. 완료 후 다시 시도하세요.',
  ZUKU_ACCOUNT_EXPIRED: 'ZUKU 연결이 만료되었거나 해제되었습니다. 다시 로그인하세요.',
  ZUKU_ACCOUNT_CHANGED: '제작을 시작한 뒤 ZUKU 계정 연결이 바뀌었습니다. 새 계정으로 실행을 다시 시작하세요.',
  ZUKU_ACCOUNT_MIGRATION_REQUIRED: '이전 시험용 계정 연결입니다. zuku login zuku로 새 서버에 다시 연결하세요.',
  ZUKU_GENERATE_SCOPE_REQUIRED: 'zuku login zuku --generate로 ZUKU 게임 생성 권한을 명시적으로 승인하세요.',
  DEPLOY_YOLO_REQUIRED: '공개 배포에는 --yolo가 필요합니다. 이 옵션은 즉시 게시할 의사 표시입니다.',
  DEPLOY_QUOTA_EXCEEDED: '게임 자동 배포는 계정당 6시간에 3회까지 가능합니다. 한도가 회복된 뒤 다시 시도하세요.',
  DEPLOY_REJECTED: '서버가 게시를 거절했습니다. 저장된 초안과 검증 결과를 확인하세요.',
  DEPLOY_SOURCE_CHANGED: '검증한 게임 패키지와 업로드할 내용이 달라 게시하지 않았습니다.',
  DEPLOY_OUTCOME_UNKNOWN: '게시 결과를 확인하지 못했습니다. 영수증의 콘텐츠를 확인하세요. 자동으로 다시 게시하지 않았습니다.',
  DEPLOY_RECEIPT_UNSAFE: '배포 복구 기록의 소유권과 접근 권한을 확인하세요.',
  DEPLOY_RECOVERY_REQUIRED: '저장된 배포 작업 키로 결과를 먼저 확인하세요. 자동으로 재게시하지 않았습니다.',
});
const SAFE_CODES = new Set(['UNAUTHORIZED', 'ACCOUNT_SUSPENDED', 'PUBLISH_BLOCKED', 'PUBLISH_STATE_CONFLICT', 'PACKAGE_INVALID', 'PACKAGE_ASSET_MISSING', 'SOURCE_UNAVAILABLE', 'BROWSER_REQUIREMENTS_MISMATCH', 'CONTENT_CHANGED', 'CONTENT_NOT_FOUND', 'OAUTH_SCOPE_DENIED', 'INVALID_DEPLOY_MODE', 'DEPLOY_QUOTA_EXCEEDED', 'PRODUCTION_DEPLOY_LIMIT', 'CLI_YOLO_REQUIRED', 'DEPLOY_IDEMPOTENCY_REQUIRED', 'DEPLOY_IDEMPOTENCY_CONFLICT', 'DEPLOY_CANONICAL_KEY_REQUIRED', 'DEPLOY_OUTCOME_UNCERTAIN', 'DEPLOYMENT_NOT_FOUND', 'DEPLOY_SOURCE_MISMATCH', 'DEPLOY_STATE_CONFLICT']);
export class AccountError extends CommandError {
  constructor(code, info = {}) {
    super(code);
    if (Object.hasOwn(MESSAGES, code)) { this.code = code; this.message = MESSAGES[code]; }
    if (SAFE_CODES.has(info.serverCode)) this.serverCode = info.serverCode;
    if (Number.isSafeInteger(info.retryAfter) && info.retryAfter >= 0 && info.retryAfter <= 21600) this.retryAfter = info.retryAfter;
    if (info.definite === true) this.definite = true;
    if (info.receipt && typeof info.receipt === 'object') this.receipt = info.receipt;
  }
  toJSON() { return { ...super.toJSON(), ...(this.serverCode ? { server_code: this.serverCode } : {}), ...(this.retryAfter !== undefined ? { retry_after: this.retryAfter } : {}), ...(this.receipt ? { receipt: this.receipt } : {}) }; }
}
