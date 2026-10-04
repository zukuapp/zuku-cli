# Experimental·비공식 Codex 연결과 소스 출처

이 기능은 로컬 ZukuJS CLI의 실험적·비공식 연결이다. OpenAI의 제품 인증이나 웹/클라우드 에이전트 제공을 뜻하지 않는다. 사용자가 최초 로그인에서 `--experimental`에 동의하면 앱 전용 보호 저장소에 동의를 기록한다. 이후 명령에도 `experimental: true`, `unofficial: true`가 표시된다.

개인 Codex 인증 파일, 브라우저 쿠키, 다른 앱의 client ID 또는 서비스 환경 키를 가져오지 않는다. 사용자가 자신의 브라우저에서 이 앱의 새 연결을 승인한다. 사용자 토큰은 CLI 결과, 진단, 명령 인수 또는 URL에 넣지 않는다. 인증 URL에는 임시 state·nonce·PKCE challenge와 앱 등록 정보만 들어간다.

## 공개 OAuth 계약

[OpenAI OSS sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)의 dynamic client 계약을 사용한다. 최초 요청은 `dynamic_agent_client`, 일관된 앱 이름 `zukujs`, 앱 설치에 저장한 `ext_agent_host_id`를 포함한다. 새 콜백에서 발급된 client ID를 받아 코드 교환과 이후 재인증에 사용한다. 파트너 client secret 또는 API key를 요구하는 흐름으로 바꾸지 않는다.

인가 주소는 `https://auth.openai.com/api/accounts/authorize`, 토큰 주소는 `https://auth.openai.com/api/accounts/oauth/token`, resource는 `https://api.openai.com/v1`이다. 콜백은 임시 포트의 `http://127.0.0.1:PORT/auth/callback`이다. 각 시도의 state, nonce, PKCE S256과 콜백 경로·호스트를 확인한다. [공식 ID-token 검증 설명](https://developers.openai.com/siwc/website)에 따라 `https://auth.openai.com/.well-known/jwks.json`의 키와 `jose`를 이용해 서명, issuer, 발급 client audience, 만료, nonce와 선택 계정의 sub를 검증한다.

[공식 갱신 계약](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions#refreshing-tokens)에 따라 발급 client ID, 저장한 최신 refresh token, resource를 보내며 scope는 생략한다. 같은 저장소의 갱신을 직렬화하고 access token·회전된 refresh token·scope·만료를 함께 원자 교체한다. 실패한 교환을 자동 반복하거나 다른 유료 공급자로 전환하지 않는다. 로그아웃은 로컬 연결을 삭제하며 서버에서 권한을 철회했다는 의미는 아니다. 진행 중 로그인은 로그아웃 후 계정 정보를 다시 생성할 수 없다.

Unix 저장은 사용자 소유 0700 디렉터리와 0600 일반 파일, symlink/hardlink 거부, 원자 교체를 사용한다. Windows 저장은 `LocalAppData/ZukuJS` 아래에서 DPAPI CurrentUser 암호화와 사용자 SID만 허용한 보호 ACL을 사용한다. 고정 Windows PowerShell 프로그램에 메모리 stdin을 전달하고 reparse point, junction, hardlink와 다른 SID 권한을 거부한다. 지원되지 않는 보호 방식에는 평문 저장으로 대체하지 않는다. 잠금 파일이 프로세스 중단 후 남으면 안전하게 실패하며 사용자가 활성 작업이 없음을 확인하고 해당 잠금 파일만 제거해야 한다.

## 추론 경계

[OpenAI preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)를 기준으로 `https://api.openai.com/v1/responses`에 `store: false`, `stream: true`, 배열 input과 instructions를 보낸다. 이전 response ID, system 메시지, 임의 도구, temperature, 호스팅된 이미지·파일·코드 실행 도구는 보내지 않는다. 모델 접근 가능 여부는 실제 성공한 추론으로 확인해야 한다.

`createCodexOAuth()`는 `login`, `status`, `logout`과 provider 내부 토큰 갱신 메서드를 제공한다. `createCodexResponsesProvider({ oauth }).runStage({ experimental: true, stage, model, instructions, input, outputSchema, signal, maxOutputBytes })`는 `{ provider, experimental, unofficial, stage, output, usage }`를 반환한다. 게임 단계의 JSON 결과만 반환하며 모델 도구 호출을 실행하지 않는다.

지원 스키마는 object, array, string, number, integer, boolean, null과 nullable type 배열, enum/const, 수치 범위, 문자열 길이, 배열 개수와 고정 게임 단계의 ID·경로·SHA·태그 패턴이다. [공식 Structured Outputs 계약](https://developers.openai.com/api/docs/guides/structured-outputs)은 일반 모델의 pattern 제약을 지원한다. 이 구현은 신뢰한 게임 단계의 유한 패턴만 허용하며 임의 정규식 프로그램, `$ref`, `oneOf` 등은 요청 전에 실패한다. object의 모든 속성을 required로 지정하고 `additionalProperties: false`를 사용한다. 스키마 깊이 16, 노드 1000, 요청 2 MiB, SSE 12 MiB 제한을 적용한다. 생성 텍스트 기본 한도는 512 KiB이고 호출자가 단계 한도를 전달할 수 있지만 최대 2 MiB를 넘지 못한다. UTF-8 SSE를 나누어 읽고 `response.completed`의 실제 최종 텍스트와 delta, 스키마를 확인한다. 종료 표시만 받거나 실패·거절·잘린 응답은 성공으로 취급하지 않는다.

검증은 로컬 fixture에서 실제 RSA 서명 JWT/JWKS, loopback 콜백과 모의 토큰/Responses 서버 응답으로 수행한다. 사용자 브라우저의 실제 OpenAI 인증·실제 모델 추론은 이 테스트로 입증되지 않는다. Windows 전용 암복호화·ACL·junction·hardlink 테스트는 Windows에서만 실행되며 다른 OS에서의 skip을 Windows 통과로 표시하지 않는다.

## 적용한 Kilo Code 소스 레퍼런스

검토한 현재 공식 저장소는 [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode/tree/76bcfd40be616a72f4697b3041565f322245b462), commit `76bcfd40be616a72f4697b3041565f322245b462`이다. 해당 commit의 [LICENSE](https://github.com/Kilo-Org/kilocode/blob/76bcfd40be616a72f4697b3041565f322245b462/LICENSE)는 MIT다. 과거 Apache 버전의 코드나 고지를 이 구현에 섞지 않는다.

| 검토한 소스 | 실제 적용한 구조와 구현 구분 |
| --- | --- |
| [codex.ts PKCE, 35–52행](https://github.com/Kilo-Org/kilocode/blob/76bcfd40be616a72f4697b3041565f322245b462/packages/opencode/src/plugin/openai/codex.ts#L35-L52) | verifier → SHA-256 → base64url challenge 구조를 적용했다. 문자열 추출·타입스크립트 코드를 복사하지 않고 Node crypto의 32-byte 난수와 digest로 새로 작성했다. |
| [codex.ts 코드 교환, 134–153행](https://github.com/Kilo-Org/kilocode/blob/76bcfd40be616a72f4697b3041565f322245b462/packages/opencode/src/plugin/openai/codex.ts#L134-L153), [콜백 대기, 279–369행](https://github.com/Kilo-Org/kilocode/blob/76bcfd40be616a72f4697b3041565f322245b462/packages/opencode/src/plugin/openai/codex.ts#L279-L369) | 로컬 콜백에서 코드 수신 후 PKCE form 교환하는 연결 구조를 적용했다. 서버·콜백 함수는 새로 작성했다. 앱 전용 dynamic client, 127.0.0.1, OIDC nonce, 엄격한 콜백·응답 검증은 공식 최신 계약에 맞춘 자체 구현이다. |
| [codex-refresh.ts, 71–121행](https://github.com/Kilo-Org/kilocode/blob/76bcfd40be616a72f4697b3041565f322245b462/packages/opencode/src/kilocode/provider/codex-refresh.ts#L71-L121) | 잠금 안에서 최신 인증을 다시 읽고 갱신하며 교체하는 구조를 적용했다. Kilo의 Flock·Promise map·auth 객체 코드를 복사하지 않고 소유권 검증을 포함한 파일 잠금과 원자 저장으로 작성했다. |

서명 JWT 검증, bounded JSON 스키마 검증, SSE 파서, 사용자 동의 저장, 계정 변경 epoch, Windows DPAPI 저장은 자체 구현이다. Kilo의 기존 고정 Codex client ID, localhost 포트, backend URL, 서명 없는 JWT decode 방식은 사용하지 않는다. Kilo 소스 레퍼런스를 바탕으로 구성한 흐름의 권리 고지를 보존하기 위해 현재 MIT 고지를 아래에 포함한다. CLI 전체 라이선스와 다른 의존성의 라이선스는 각 파일·패키지의 고지를 따른다.

```text
MIT License

Copyright (c) 2026 Kilo Code
Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

Windows 파일 생성 시점의 ACL 적용은 [Microsoft FileStream 생성자 계약](https://learn.microsoft.com/en-us/dotnet/api/system.io.filestream.-ctor?view=netframework-4.8.1)을 따른다. 표준 `C:\Windows`의 고정 PowerShell 5.1과 .NET Framework API만 사용한다. 환경 변수로 지정한 다른 실행 파일, PowerShell 7 또는 다른 OS에 같은 보호를 제공한다고 주장하지 않는다. 다른 시스템 설치 경로에서는 보호 저장을 안전하게 거부한다.
