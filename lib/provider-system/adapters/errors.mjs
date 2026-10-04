// Fixed, public-safe adapter errors. Messages never include remote bodies,
// header values, credentials, stack traces or request URLs.
const MESSAGES = Object.freeze({
  ADAPTER_INVALID_DESCRIPTOR: '공급자 설정을 확인하세요.',
  ADAPTER_UNKNOWN_API_TYPE: '지원하지 않는 공급자 API 유형입니다.',
  ADAPTER_ENDPOINT_REJECTED: '공급자 주소는 공식 HTTPS 주소이거나 명시적으로 설정한 HTTPS/루프백 주소여야 합니다.',
  ADAPTER_HEADER_REJECTED: '공급자 헤더 이름이나 값이 허용되지 않습니다.',
  ADAPTER_CREDENTIALS_MISSING: '이 공급자에 필요한 인증 정보가 설정되지 않았습니다.',
  ADAPTER_CREDENTIALS_INVALID: '공급자 인증 정보 형식이 올바르지 않습니다.',
  ADAPTER_MODEL_REQUIRED: '모델을 명시적으로 선택하세요.',
  ADAPTER_MODEL_INVALID: '모델 ID 형식이 올바르지 않습니다.',
  ADAPTER_REQUEST_INVALID: '공급자 요청 형식이 올바르지 않거나 허용 한도를 넘었습니다.',
  ADAPTER_UNSUPPORTED: '이 공급자는 요청한 기능을 지원하지 않습니다.',
  ADAPTER_SDK_UNAVAILABLE: '이 공급자에 필요한 공식 SDK가 설치되지 않았습니다.',
  ADAPTER_NATIVE_UNAVAILABLE: 'ZUKU AI 네이티브 추론 계약이 아직 제공되지 않습니다.',
  NATIVE_CONTRACT_MISMATCH: '서버와 설치된 게임 제작 규격이 다릅니다. ZUKU를 업데이트하세요.',
  NATIVE_INPUT_TOO_LARGE: 'ZUKU AI 게임 제작 입력 한도를 넘었습니다.',
  NATIVE_STAGE_FAILED: 'ZUKU AI 게임 제작 단계가 실패했습니다.',
  NATIVE_STAGE_PROCESSING: 'ZUKU AI 요청이 처리 중입니다. 저장된 요청의 상태를 확인하세요.',
  NATIVE_OUTCOME_UNCERTAIN: 'ZUKU AI 요청의 결과를 확인해야 합니다. 새 추론 요청을 자동으로 보내지 않습니다.',
  NATIVE_RESULT_EXPIRED: 'ZUKU AI 결과 보관 기간이 지났습니다. 기존 요청을 자동 재실행하지 않습니다.',
  ADAPTER_CODEX_UNAVAILABLE: '실험적 Codex 클라이언트를 사용할 수 없습니다.',
  PROVIDER_AUTH_FAILED: '공급자 인증에 실패했습니다. 인증 정보를 확인하세요.',
  PROVIDER_FORBIDDEN: '공급자가 이 요청을 거부했습니다.',
  PROVIDER_NOT_FOUND: '공급자에서 모델이나 경로를 찾지 못했습니다.',
  PROVIDER_BAD_REQUEST: '공급자가 요청을 거부했습니다.',
  PROVIDER_CONTEXT_OVERFLOW: '입력이 모델 컨텍스트 한도를 넘었습니다.',
  PROVIDER_RATE_LIMITED: '공급자 요청 한도를 넘었습니다. 자동 재시도는 하지 않습니다.',
  PROVIDER_UNAVAILABLE: '공급자에 연결하지 못했습니다. 자동 재시도나 다른 공급자로의 전환은 하지 않습니다.',
  PROVIDER_REDIRECT_REJECTED: '공급자 리디렉션은 따르지 않습니다.',
  PROVIDER_TIMEOUT: '공급자 응답 시간이 초과되었습니다.',
  PROVIDER_RESPONSE_INVALID: '공급자 응답 형식이 올바르지 않습니다.',
  PROVIDER_RESPONSE_TOO_LARGE: '공급자 응답이 허용 크기를 넘었습니다.',
  PROVIDER_STREAM_ERROR: '공급자 스트림이 오류로 끝났습니다.',
  PROVIDER_CONTENT_FILTERED: '공급자가 응답을 차단했습니다.',
  STAGE_OUTPUT_INVALID: '모델 출력이 요구된 JSON 형식이 아닙니다.',
  STAGE_OUTPUT_TOO_LARGE: '모델 출력이 허용 크기를 넘었습니다.',
  STAGE_INCOMPLETE: '모델 출력이 완료되지 않았습니다.',
  COMMAND_CANCELLED: '명령을 취소했습니다.',
});

export class AdapterError extends Error {
  constructor(code, { status } = {}) {
    const known = Object.hasOwn(MESSAGES, code);
    super(known ? MESSAGES[code] : MESSAGES.PROVIDER_UNAVAILABLE);
    this.name = 'ZukuProviderAdapterError';
    this.code = known ? code : 'PROVIDER_UNAVAILABLE';
    // Only the numeric HTTP status is kept; never headers or bodies.
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
  }
  toJSON() { return { code: this.code, message: this.message, ...(this.status ? { status: this.status } : {}) }; }
}

export const ADAPTER_ERROR_CODES = Object.freeze(Object.keys(MESSAGES));
export const fail = (code, options) => { throw new AdapterError(code, options); };

/** Wrap an unknown failure without carrying its message or stack. */
export function safeError(error, signal) {
  if (signal?.aborted) return error instanceof AdapterError && error.code === 'PROVIDER_TIMEOUT' ? error : new AdapterError('COMMAND_CANCELLED');
  if (error instanceof AdapterError) return error;
  return new AdapterError('PROVIDER_UNAVAILABLE');
}

/** HTTP status → fixed code. `hint` is a lowercase classification derived locally, never echoed. */
export function statusError(status, hint) {
  if (hint === 'context') return new AdapterError('PROVIDER_CONTEXT_OVERFLOW', { status });
  if (status === 401) return new AdapterError('PROVIDER_AUTH_FAILED', { status });
  if (status === 403) return new AdapterError('PROVIDER_FORBIDDEN', { status });
  if (status === 404) return new AdapterError('PROVIDER_NOT_FOUND', { status });
  if (status === 408 || status === 504) return new AdapterError('PROVIDER_TIMEOUT', { status });
  if (status === 413) return new AdapterError('PROVIDER_CONTEXT_OVERFLOW', { status });
  if (status === 429) return new AdapterError('PROVIDER_RATE_LIMITED', { status });
  if (status >= 300 && status < 400) return new AdapterError('PROVIDER_REDIRECT_REJECTED', { status });
  if (status >= 400 && status < 500) return new AdapterError('PROVIDER_BAD_REQUEST', { status });
  return new AdapterError('PROVIDER_UNAVAILABLE', { status });
}
