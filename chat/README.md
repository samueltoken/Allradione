# Allradione 전체 채팅

방송 재생은 청취자의 PC에서 처리합니다. 사용자가 채팅을 열면 이 Worker의 공용 방에 접속하고, 접으면 연결을 닫습니다. 닉네임과 메시지는 방에 공유됩니다. 사용자는 다른 사용자를 숨기거나 메시지를 신고할 수 있습니다.

## 로컬 검사

프로젝트 루트에서 다음 명령을 실행하면 독립된 시험용 방에서 두 접속자의 대화와 신고 처리를 검사합니다.

```sh
npm ci --prefix chat
node --test chat/test.cjs
```

## 배포와 신고 처리

배포 설정은 Allradione 계정에 고정되어 있습니다. 이 PC의 PowerShell에서는 아래 명령으로 프로젝트 전용 인증을 사용합니다.

```powershell
$env:XDG_CONFIG_HOME = Join-Path $env:LOCALAPPDATA 'Allradione-Cloudflare'
Set-Location chat
node node_modules/wrangler/bin/wrangler.js deploy
```

신고 목록 조회와 삭제는 `POST /moderate`에서 처리합니다. 요청에는 `Authorization: Bearer <MODERATOR_KEY>`를 사용합니다. JSON 본문은 신고 목록 조회 시 `{"action":"reports"}`, 메시지 삭제 시 `{"action":"remove","message":123}`입니다. 서버 비밀 값은 Wrangler의 `secret put MODERATOR_KEY`로 교체할 수 있습니다.
