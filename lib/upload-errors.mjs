import { CommandError } from './errors.mjs';

// Upload-specific codes live here so the shared error table stays coordinator-owned.
// UploadError extends CommandError, so the existing entrypoint renders it as a stable error object.
const MESSAGES = Object.freeze({
  UPLOAD_INPUT_UNSAFE: 'ZukuJS 업로드 입력은 심볼릭 링크가 아닌 일반 .zwf/.zip 파일 또는 프로젝트 디렉터리여야 합니다.',
  UPLOAD_INPUT_TOO_LARGE: 'ZukuJS 패키지가 업로드 한도(전체 multipart 500MiB)를 넘습니다. 네트워크 요청을 보내지 않았습니다.',
  PACKAGE_INVALID: 'ZukuJS 패키지 검증에 실패했습니다. 네트워크 요청을 보내지 않았습니다.',
  UPLOAD_METADATA_INVALID: 'ZukuJS 초안 메타데이터를 확인하세요. 네트워크 요청을 보내지 않았습니다.',
  UPLOAD_PACKAGER_UNAVAILABLE: '프로젝트 디렉터리 패키징 기능이 연결되지 않았습니다. 먼저 zukujs package로 .zwf를 만든 뒤 업로드하세요.',
  UPLOAD_RECEIPT_UNSAFE: '업로드 영수증 위치가 안전하지 않습니다. 심볼릭 링크가 아닌 사용자 디렉터리를 지정하세요.',
  UPLOAD_NOT_CONFIGURED: 'ZukuJS 업로드 명령이 아직 CLI 진입점에 연결되지 않았습니다. 작업을 수행하지 않았습니다.',
  API_REDIRECT_REJECTED: '리디렉션 응답을 거부했습니다. 자격 증명을 다른 주소로 보내지 않았습니다.',
  API_REQUEST_FAILED: 'API가 요청을 거부했습니다.',
  UPLOAD_OUTCOME_UNKNOWN: '업로드 결과를 확인하지 못했습니다. 자동으로 다시 시도하지 않았습니다. 영수증을 확인하세요.',
  UPLOAD_RECEIPT_MISMATCH: '서버 업로드 응답이 로컬 패키지(크기·해시·형식·경로)와 일치하지 않습니다. 초안을 만들지 않았습니다.',
  DRAFT_OUTCOME_UNKNOWN: '초안 생성 결과를 확인하지 못했습니다. 자동으로 다시 시도하지 않았습니다. 영수증을 확인하세요.',
  DRAFT_STATE_UNEXPECTED: '생성된 콘텐츠가 초안(draft) 상태가 아닙니다. 영수증을 확인하세요.',
  // Public API error codes from the /api/v1 uploader and contents contract.
  BAD_REQUEST: '요청 형식이 올바르지 않습니다.',
  UNSAFE_PACKAGE: '서버가 패키지를 안전하지 않은 것으로 거부했습니다.',
  INVALID_PACKAGE: '서버가 패키지를 올바르지 않은 것으로 거부했습니다.',
  GAME_UPLOAD_UNSUPPORTED: '현재 계정으로 게임 업로드를 할 수 없습니다.',
  CSRF_REJECTED: '서버가 요청 출처를 거부했습니다.',
  PAYLOAD_TOO_LARGE: '서버가 업로드 크기를 거부했습니다.',
  UNSUPPORTED_MEDIA_TYPE: '서버가 파일 형식을 지원하지 않습니다.',
  VALIDATION_ERROR: '서버가 입력값 검증에 실패했습니다.',
  MALWARE_DETECTED: '서버 검사에서 패키지가 거부되었습니다.',
  INTERNAL_ERROR: '서버 내부 오류가 발생했습니다.',
  STORAGE_UNAVAILABLE: '서버 저장소를 사용할 수 없습니다. 잠시 후 확인하세요.',
  UPLOAD_UNAVAILABLE: '업로드 서비스를 사용할 수 없습니다. 잠시 후 확인하세요.',
});
export const API_ERROR_CODES = Object.freeze(new Set(['BAD_REQUEST', 'UNSAFE_PACKAGE', 'INVALID_PACKAGE', 'UNAUTHORIZED', 'FORBIDDEN', 'ACCOUNT_SUSPENDED', 'GAME_UPLOAD_UNSUPPORTED', 'CSRF_REJECTED', 'NOT_FOUND', 'PAYLOAD_TOO_LARGE', 'UNSUPPORTED_MEDIA_TYPE', 'VALIDATION_ERROR', 'MALWARE_DETECTED', 'RATE_LIMITED', 'INTERNAL_ERROR', 'STORAGE_UNAVAILABLE', 'UPLOAD_UNAVAILABLE']));
const SAFE_TOKEN = /^[a-z0-9_.[\]-]{1,64}$/i;

export class UploadError extends CommandError {
  /** @param {string} code @param {{reason?: string, stage?: string, httpStatus?: number, fields?: string[], receipt?: object}} [info] */
  constructor(code, info = {}) {
    super(code);
    if (Object.hasOwn(MESSAGES, code)) { this.code = code; this.message = MESSAGES[code]; }
    // Only allowlisted, locally generated detail tokens are kept; remote messages are never stored.
    if (typeof info.reason === 'string' && SAFE_TOKEN.test(info.reason)) this.reason = info.reason;
    if (typeof info.stage === 'string' && SAFE_TOKEN.test(info.stage)) this.stage = info.stage;
    if (Number.isSafeInteger(info.httpStatus) && info.httpStatus >= 100 && info.httpStatus <= 599) this.httpStatus = info.httpStatus;
    if (Array.isArray(info.fields)) this.fields = info.fields.filter(field => typeof field === 'string' && SAFE_TOKEN.test(field)).slice(0, 10);
    if (info.receipt) this.receipt = info.receipt;
  }
  toJSON() {
    const json = super.toJSON();
    for (const [key, value] of [['reason', this.reason], ['stage', this.stage], ['http_status', this.httpStatus], ['fields', this.fields?.length ? this.fields : undefined], ['receipt', this.receipt]]) if (value !== undefined) json[key] = value;
    return json;
  }
}
/** Wrap any error from the upload pipeline without leaking its message or stack contents. */
export const asUploadError = (error, info) => {
  if (error instanceof UploadError) { if (info?.receipt && !error.receipt) error.receipt = info.receipt; return error; }
  if (error instanceof CommandError) return new UploadError(error.code, info);
  return new UploadError('COMMAND_FAILED', info);
};
