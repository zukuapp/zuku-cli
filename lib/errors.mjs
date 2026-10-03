const MESSAGES = Object.freeze({
  INVALID_INPUT: '인수를 확인하세요. zuku help로 사용법을 볼 수 있습니다.',
  UNKNOWN_COMMAND: '등록되지 않은 명령입니다. zuku help로 목록을 확인하세요.',
  NOT_IMPLEMENTED: '이 시제품 명령은 아직 구현되지 않았습니다. 작업을 수행하지 않았습니다.',
  CREDENTIALS_INVALID: '사용자 토큰 형식을 확인하세요. 토큰은 출력하거나 명령 인수로 전달하지 마세요.',
  CREDENTIALS_UNSAFE: '자격 증명은 사용자 소유의 일반 파일이어야 하며 권한은 0600이어야 합니다. 환경 변수도 사용할 수 있습니다.',
  API_ORIGIN_REJECTED: '공식 공개 API 주소만 사용할 수 있습니다.',
  API_READ_ONLY: '이 CLI는 허용된 읽기 전용 진단 API만 호출합니다.',
  API_RESPONSE_INVALID: '공개 API 응답 형식이 올바르지 않습니다.',
  API_UNAVAILABLE: 'API 연결을 확인하지 못했습니다. 잠시 후 다시 확인하세요.',
  UNAUTHORIZED: '인증이 필요하거나 세션이 만료되었습니다. 현재 사용자 토큰을 확인하세요.',
  FORBIDDEN: '이 요청에 접근할 수 없습니다.',
  ACCOUNT_SUSPENDED: '현재 계정으로 접근할 수 없습니다.',
  AUTH_UNAVAILABLE: '인증 상태를 확인하지 못했습니다. 잠시 후 다시 확인하세요.',
  BILLING_UNAVAILABLE: '서비스 목록을 확인하지 못했습니다. 잠시 후 다시 확인하세요.',
  RATE_LIMITED: '요청이 너무 많습니다. 잠시 후 다시 확인하세요.',
  NOT_FOUND: '진단 API를 찾지 못했습니다.',
  COMMAND_CANCELLED: '명령을 취소했습니다.',
  COMMAND_FAILED: '명령을 완료하지 못했습니다.',
});
export class CommandError extends Error {
  constructor(code) { super(MESSAGES[code] ?? MESSAGES.COMMAND_FAILED); this.name = 'ZukuJSCommandError'; this.code = Object.hasOwn(MESSAGES, code) ? code : 'COMMAND_FAILED'; }
  toJSON() { return { code: this.code, message: this.message }; }
}
