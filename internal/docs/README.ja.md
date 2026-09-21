# DevRelay 日本語クイックスタート

DevRelayは、開発PCのコマンドラインをMCPクライアントから扱うための最小構成のMCPサーバーです。Gitやnpmなどの機能を独自実装せず、既存CLIをそのまま実行する設計です。

## ビルドとテスト

```powershell
cd C:\Users\<user>\Downloads\DevRelay\internal
npm install
npm run build
npm test
```

ローカルコマンドとして登録する場合は `npm link` を実行します。

## stdioで起動

```powershell
devrelay
```

引数なしではstdioが使われます。MCPホストがDevRelayを子プロセスとして起動する用途向けです。

## HTTPで起動

```powershell
devrelay --http
```

既定のMCPエンドポイントは `http://127.0.0.1:7317/mcp` です。リモートから利用する場合も、通常はこのループバック待受けを維持し、外側にMCPトンネルや認証済みゲートウェイを置きます。

## 基本的な使い分け

短時間で終了するコマンドは `exec`、開発サーバーやREPLのような長時間プロセスは `process_start` を使います。Codex CLIやTUIのように端末を占有するプログラムは `terminal: true` でPTY/ConPTYセッションとして起動できます。複数セッションは同時に保持できます。長時間プロセスの出力は `process_read` の `nextCursor` を次回の `cursor` に渡すことで差分だけ取得できます。

`process_write` はstdin/PTY入力とPTYサイズ変更、`process_stop` はセッション停止、`process_list` はクラスタ内のデバイスのonline/offline状態と保持中セッションを返します。`exec` と `process_start` では `device` に表示名・自動名・alias・nodeIdを指定できます。`exec.images` と `process_read.images` を使うと、CLIが生成・参照したPNG/JPEG/WebP/GIFをMCP画像として返せます。

## v0.1で意図的に持たないもの

MCPコアにはDB、Git専用API、ファイル専用API、Docker専用API、一般的なGUI自動操作API、組み込みトンネル、LLM/エージェント機能を含めません。PTY/ConPTYと画像返却は、CLIだけでは不足する部分を既存6ツールのオプションとして最小限補完します。WindowsのランチャーGUIはコアとは分離したローカル制御UIです。

## Windowsでは2つのランチャーを使う

通常は用途に応じて、プロジェクト直下の `DevRelay ChatGPT.cmd` または `DevRelay HTTPS.cmd` をダブルクリックします。

- `DevRelay ChatGPT.cmd`: GUIをOpenAI Secure MCP Tunnelモードで開きます。
- `DevRelay HTTPS.cmd`: GUIをCloudflare Named Tunnelモードで開きます。固定HTTPS URLのMCPはOAuth 2.1（Authorization Code + PKCE）で保護されます。

HTTPSモードでChatGPTなどがOAuth認可を開始すると、設定パネルが自動で開いて接続元・リダイレクト先・scopeを表示します。ローカルGUIでApproveした場合だけ認可コードが発行され、Denyなら拒否されます。公開ブラウザ画面だけでは承認できません。

GUIはOS標準フレームを使わないWPF/WebView2ウィンドウで、既定サイズは780×560です。本文は `Command log` と `Server log` だけに絞り、赤いStart/Stopと歯車は自前タイトルバーに置きます。最小化・最大化/復元・閉じるは `audio-router` と同じSegoe Fluent Iconsのグリフ方式です。フォントはNoto Sans Monoで、未導入PCではランチャーがGoogle Fonts公式版を現在ユーザーへ導入します。テーマは `vault-edit` と同じ `#FFFFFF Soft` が既定で、設定から `#000000 Soft` に切り替えられます。各ウィンドウ起動のログは `internal/.devrelay/logs/` に保存し、直近3回だけ保持します。GUIを閉じるとDevRelayとトンネルも停止します。詳細は [launcher.md](launcher.md) を参照してください。

## 複数デバイス

各ノードは変更されない `nodeId` と、人間向けの `name` / `defaultName` / `aliases` を持ちます。既定名はOSとハードウェアから生成され、このPCでは `windows-ryzen9-3900x` のような形式になります。Raspberry PiではCPU名よりボード名を優先し、例として `linux-rpi5` になります。

中央DirectoryやGatewayは置きません。各ノードは既定7319番のpeer APIで直接通信し、同じ32-byte cluster keyでHMAC認証します。小規模構成ではSettingsのPeersへ各ノードのプライベートURLを相互に登録するフルメッシュを推奨します。複数PCが同じCloudflare Named Tunnelへconnectorとして参加すれば、ChatGPT側のMCP URLは1個のままです。詳細は [cluster.md](cluster.md) を参照してください。
