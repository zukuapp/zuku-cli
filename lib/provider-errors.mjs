import { CommandError } from './errors.mjs';

const MESSAGES = Object.freeze({
  CODEX_EXPERIMENTAL_REQUIRED: 'Codex 연결은 Experimental·비공식 기능입니다. --experimental을 명시하세요.',
  CODEX_INPUT_INVALID: 'Codex 공급자 요청 형식을 확인하세요.',
  CODEX_AUTH_REQUIRED: 'Experimental Codex 로그인이 필요합니다.',
  CODEX_STORE_UNSAFE: 'Codex 자격 증명은 사용자 소유의 0600 일반 파일과 0700 디렉터리에 보관해야 합니다.',
  CODEX_STORE_INVALID: 'Codex 자격 증명 저장 형식이 올바르지 않습니다.',
  CODEX_STORE_LOCKED: '다른 Codex 인증 작업이 진행 중입니다. 잠시 후 다시 시도하세요.',
  CODEX_PLATFORM_UNSUPPORTED: '이 환경에서는 Codex 자격 증명의 안전한 저장을 확인할 수 없습니다. 검증된 보호 저장 환경을 사용하세요.',
  CODEX_AUTH_CANCELLED: 'Codex 인증 작업을 취소했습니다.',
  CODEX_AUTH_TIMEOUT: 'Codex 인증 시간이 지났습니다. 새 로그인을 시작하세요.',
  CODEX_AUTH_DENIED: 'OpenAI 인증 또는 ChatGPT 사용 권한이 허용되지 않았습니다.',
  CODEX_AUTH_RESPONSE_INVALID: 'OpenAI 인증 응답 검증에 실패했습니다.',
  CODEX_IDENTITY_INVALID: 'OpenAI 서명·계정·client·nonce 검증에 실패했습니다.',
  CODEX_AUTH_SESSION_CHANGED: '진행 중 인증의 계정이 변경되었습니다. 새 로그인을 시작하세요.',
  CODEX_REAUTH_REQUIRED: 'Codex 인증을 갱신하지 못했습니다. 새 로그인이 필요합니다.',
  CODEX_NETWORK_ERROR: 'OpenAI에 연결하지 못했습니다. 연결을 확인하세요.',
  CODEX_RESPONSE_INVALID: 'Codex 추론 응답이 지정한 형식과 일치하지 않습니다.',
  CODEX_RESPONSE_LIMIT: 'Codex 응답이 처리 한도를 넘었습니다.',
  CODEX_RATE_LIMITED: 'Codex 사용 한도에 도달했습니다. 자동으로 유료 공급자로 전환하지 않습니다.',
  CODEX_INFERENCE_FAILED: 'Codex 추론이 실패했습니다.',
});

export class ProviderError extends CommandError {
  constructor(code) {
    const safeCode = Object.hasOwn(MESSAGES, code) ? code : 'CODEX_INFERENCE_FAILED';
    super(safeCode);
    this.message = MESSAGES[safeCode];
    this.name = 'ZukuJSProviderError';
    this.code = safeCode;
  }
  toJSON() { return { code: this.code, message: this.message, experimental: true, unofficial: true }; }
}

export function requireExperimental(value) {
  if (value !== true) throw new ProviderError('CODEX_EXPERIMENTAL_REQUIRED');
}

export function checkCancelled(signal) {
  if (signal?.aborted) throw new ProviderError('CODEX_AUTH_CANCELLED');
}

export const providerMetadata = Object.freeze({ provider: 'codex-oauth', experimental: true, unofficial: true });
