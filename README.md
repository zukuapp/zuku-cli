# zuku-cli

ZUKU(즈쿠) Jump 프로젝트를 **검증·패키징·업로드**하는 커맨드라인 도구입니다.

> OpenAPI: [`zuku-api`](https://github.com/zukuapp/zuku-api) · 엔진 계약: [`zuku-engine-next2d`](https://github.com/zukuapp/zuku-engine-next2d)

## 설치

```bash
npm install -g zuku-cli
```

## 사용

```bash
zuku --help
```

| 명령 | 설명 |
|------|------|
| `zuku create <name>` | Jump 프로젝트 스캐폴드 |
| `zuku validate <path>` | `jump.manifest.json` / `zuku.manifest.json` 검증 |
| `zuku package <path>` | 업로드용 ZIP 생성 |
| `zuku upload <path>` | 플랫폼 업로드 |

### 예

```bash
zuku create my-game
zuku validate ./my-game
zuku package ./my-game
# 인증: ZUKU_TOKEN 또는 ~/.zukurc
zuku upload ./my-game.zip
```

## 설정

`~/.zukurc`:

```json
{
  "api_base": "https://api.zuzunza.com/v1",
  "token": "your-api-token"
}
```

또는 환경 변수: `ZUKU_API_BASE`, `ZUKU_TOKEN` / `ZUKU_API_KEY`

## 개발

```bash
node index.mjs --help
npm test
```

## 관련

- [zuku-api](https://github.com/zukuapp/zuku-api)
- [zuku-engine-next2d](https://github.com/zukuapp/zuku-engine-next2d)
- [zuku-docs](https://github.com/zukuapp/zuku-docs)

---

**ZUKU (즈쿠)** · Tresillo · [zuzunza.com](https://zuzunza.com)
