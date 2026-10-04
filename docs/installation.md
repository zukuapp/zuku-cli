# ZukuJS CLI 설치

짧은 명령 이름은 `zuku`이며 `zukujs`도 동등하게 사용할 수 있습니다.
두 별칭은 같은 CLI 실행 파일과 설정·로그인 상태를 공유합니다.

현재 아래 공개 설치 주소는 배포·실제 HTTPS 검증을 기다리는 상태입니다.
검증이 완료되기 전에는 설치 명령이 실패할 수 있습니다. 저장소의 설치
소스와 공개 주소의 설치 도구는 같은 고정 릴리스 계약으로 생성합니다.

## Linux와 macOS

curl 또는 wget으로 설치 도구를 받은 뒤 Bash에서 실행합니다.

```sh
curl -fsSL --proto '=https' --tlsv1.2 https://zuzunza.com/install.sh -o install-zukujs.sh && bash install-zukujs.sh
```

```sh
wget --https-only -O install-zukujs.sh https://zuzunza.com/install.sh && bash install-zukujs.sh
```

기본 설치 경로는 `~/.local/share/zukujs`, 실행 파일은
`~/.local/bin/zuku`와 `~/.local/bin/zukujs`입니다.
현재 터미널에서 실행 파일을 찾지 못하면:

```sh
export PATH="$HOME/.local/bin:$PATH"
zuku --version
```

새 터미널에서도 사용하려면 사용하는 셸의 PATH 설정에 이 디렉터리를
추가하세요. 설치 도구는 셸 설정 파일을 수정하지 않습니다.

## Windows PowerShell

PowerShell의 `irm`(`Invoke-RestMethod`)으로 설치 도구를 실행합니다.

```powershell
& ([scriptblock]::Create((irm 'https://zuzunza.com/install.ps1')))
zuku --version
```

기본 설치 경로는 `%LOCALAPPDATA%\ZukuJS`, 실행 파일은 그 아래
`bin\zuku.cmd`와 `bin\zukujs.cmd`입니다. 설치 도구는 현재 PowerShell의 PATH에 이 `bin`
디렉터리를 추가합니다. 새 터미널에서도 사용하려면 Windows의 **사용자
환경 변수 → Path**에 `%LOCALAPPDATA%\ZukuJS\bin`을 추가하세요.
관리자 권한이나 PowerShell 프로필 수정은 필요하지 않습니다.

## 설치 옵션

| Bash | PowerShell | 설명 |
| --- | --- | --- |
| `--prefix /절대/경로` | `-Prefix 'C:\절대\경로'` | 사용자 소유 디렉터리에 설치하고 그 아래 `bin`에 실행 파일 생성 |
| `--no-node` | `-NoNode` | CLI만 포함하는 릴리스에서 기존 Node.js 22 이상과 npm 사용 |
| `--dry-run` | `-DryRun` | 다운로드·쓰기 없이 설치 계획 확인 |
| `--help` | `-Help` | 옵션 안내 |

공백이나 한글이 있는 경로는 따옴표로 감싸세요.

```sh
bash install-zukujs.sh --prefix "$HOME/도구/ZukuJS CLI" --dry-run
export PATH="$HOME/도구/ZukuJS CLI/bin:$PATH"
```

```powershell
& ([scriptblock]::Create((irm 'https://zuzunza.com/install.ps1'))) -Prefix "$env:LOCALAPPDATA\도구\ZukuJS CLI" -DryRun
```

Linux/macOS x64·arm64와 Windows x64·arm64를 대상으로 합니다.
Studio를 포함하는 릴리스는 CLI·공유 Agent Core·Studio가 공식 Node.js
22.22.3 런타임 하나를 함께 사용하도록 사용자 설치 디렉터리에 설치합니다.
이 릴리스에서 `--no-node` 또는 `-NoNode`를 지정하면 설치 전에 오류를 표시합니다.
CLI만 포함하는 이전 릴리스는 기존 Node.js 22 이상과 npm을 사용하며,
없으면 고정된 공식 런타임을 함께 설치합니다.
시스템 Node.js나 기존 시스템 경로의 관리자용 실행 파일을
바꾸지 않습니다. 사용자 `bin`을 PATH에 추가하면 설치한 별칭을 사용할 수 있습니다.
Linux에서 공식 Node.js 바이너리를 실행할 수 있는 시스템 환경이 필요합니다.

## 다운로드와 재설치

설치 도구는 공개 사이트의 고정 버전 CLI 아카이브와 공식 Node.js
아카이브를 HTTPS로 받습니다. Studio를 포함하는 릴리스는 해당 플랫폼의
검증된 네이티브 파일도 [공식 GitHub 릴리스](https://github.com/zukuapp/zukujs-cli/releases)에서
받습니다. 각 아카이브의 SHA-256을 고정된 릴리스 값과 비교한 뒤 설치합니다.
Studio는 설치된 CLI와 공통 소스·프로토콜 버전도 맞아야 합니다.
검증된 플랫폼 파일이 없는 경우 설치 전에 오류를 표시합니다.
CLI 의존성은 아카이브에 포함되며 npm 설치는 오프라인으로 수행합니다.
게임 테스트용 브라우저 실행 파일은 이 의존성 번들과 별개입니다.

같은 설치 명령을 다시 실행해도 같은 설치 경로를 사용할 수 있습니다.
다운로드 검증이나 설치 확인이 실패하면 이전 설치와 두 별칭을 함께
보존하거나 복원합니다. 설치 경로에 다른 프로그램의 `zuku` 또는 `zukujs`
실행 파일이 있으면 덮어쓰지 않으므로 별도
`--prefix` 또는 `-Prefix`를 선택하세요.

## 설치 확인

```sh
zuku --version
zuku create my-game
zukujs validate my-game
```

Studio가 포함된 릴리스에서는 다음 명령으로 실행합니다.

```sh
zuku studio
# zukujs studio도 같은 Studio와 Agent Core를 사용합니다.
```

Linux Studio에는 그래픽 데스크톱과 GTK 3·WebKitGTK 4.1 시스템 라이브러리가
필요합니다. 설치 도구는 시스템 패키지를 설치하거나 관리자 권한을 요청하지 않습니다.
브라우저 연결은 같은 로컬 Agent Core를 사용하며, 실제 프로젝트 접근은
네이티브 화면에서 승인해야 합니다.

공개 주소를 통한 실제 설치 검증은 아직 완료되지 않았습니다. Linux 로컬
검사에서는 두 별칭의 프로젝트 생성·검사·자동완성, 새 아카이브의 오프라인
설치, 포함된 의존성·필수 스킬의 SHA 검증, 공백·한글 경로, 재설치,
잘못된 체크섬 거부와 두 번째 별칭 교체 실패 시 복원을 확인했습니다.
공식 Node.js 22.22.3 Linux 아카이브의 SHA-256과 실제 런타임 자동 설치도
확인했습니다. Windows와
macOS의 실제 설치 실행은 해당 GitHub CI가 통과한 뒤 확인된 것으로 기록합니다.
새 Studio 설치 검사는 합성 네이티브 파일·런타임으로 설치, 소스·프로토콜
불일치 거부, 허용되지 않은 다운로드 주소 거부, 두 번째 별칭 실패 시
Studio와 두 별칭의 복원을 확인했습니다. 이 검사는 실제 Windows·macOS
설치 실행이나 공개 릴리스 파일의 검증을 대신하지 않습니다.
CI의 런타임 자동 설치 검사는 합성 아카이브를 사용하며, 공식 Node.js 배포
아카이브 검증과 별도로 기록합니다. 공개 설치 주소의 실제 HTTPS 검증은
아직 대기 중입니다.
