# DevRelay 日本語クイックスタート

DevRelayは、開発PCのコマンドラインをMCPクライアントから扱うための最小構成のMCPサーバーです。Gitやnpmなどの機能を独自実装せず、既存CLIをそのまま実行する設計です。

## ビルドとテスト

```powershell
cd .\internal
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

`process_write` はstdin/PTY入力とPTYサイズ変更、`process_stop` はセッション停止、`process_list` はDevRelayが保持中のセッション一覧です。通常のMCP結果は重複メタデータを省いたcompact JSONで返し、必要な場合は `detail: "full"` で詳細情報を取得できます。`exec.images` と `process_read.images` を使うと、CLIが生成・参照したPNG/JPEG/WebP/GIFをMCP画像として返せます。

## v0.1で意図的に持たないもの

MCPコアにはDB、Git専用API、ファイル専用API、Docker専用API、一般的なGUI自動操作API、組み込みトンネル、LLM/エージェント機能を含めません。PTY/ConPTYと画像返却は、CLIだけでは不足する部分を既存6ツールのオプションとして最小限補完します。WindowsのランチャーGUIはコアとは分離したローカル制御UIです。

## WindowsではDevRelay.cmdを使う

通常はプロジェクト直下の `DevRelay.cmd` をダブルクリックします。起動前に最新のpublished GitHub Releaseを確認し、その後にローカルの接続セットアップ状態を確認します。

新規インストールでは通常GUIより先に、ライトテーマの別ウィンドウ **DevRelay Setup** が開きます。接続方式はこのWizardが管理し、メインGUIのSettingsには従来の `Mode` 選択はありません。

接続方式は次の構成です。

- **OpenAI Secure Tunnel**: 構成としては推奨ですが、ChatGPT/tunnel-client側の既知問題があるため現在はExperimental表示です。Wizardはopenai/tunnel-clientの #71、#57、#41 を正式なissue名と番号で表示し、GitHubへ接続できる場合はOPEN/CLOSED状態も非同期で確認します。
- **HTTPS / Tailscale Funnel**: HTTPSでは推奨です。独自ドメインは不要で、必要ならWizardから公式Windows版Tailscaleのインストール、通常のブラウザログイン、Funnel準備へ進めます。
- **HTTPS / Cloudflare Named Tunnel**: 固定hostnameを使えますが、CloudflareアカウントとCloudflare管理下のドメインが必要です。Dashboardのブラウザ自動操作はせず、公式 `cloudflared` CLIのログイン・Tunnel作成・DNS routeを使います。
- **HTTPS / Cloudflare Quick Tunnel**: アカウントもドメインも不要ですが、`trycloudflare.com` のURLは一時的で、Tunnel再作成後に変わることがあります。

Wizardの最後にはChatGPTへの登録手順も表示します。OpenAI Secure TunnelではTunnel接続 + MCP側 `No authentication`、HTTPSでは公開 `/mcp` URL + `OAuth` を案内します。HTTPSのOAuth要求は通常のDevRelayウィンドウでApprove/Denyします。

一度セットアップした後は、メインSettingsの `Connection Setup...` から同じ別ウィンドウを再度開けます。新しい接続は **Finish setup** まで現在の `setup.json` を置き換えません。Cancel/ウィンドウを閉じた場合はWizard中に変更したローカル接続ファイルを復元します。Advanced ResetはDevRelay側の接続設定だけを消し、Tailscaleのアンインストールやprovider側のremote resource削除は自動では行いません。

GUIはOS標準フレームを使わないWPF/WebView2ウィンドウです。本文は `Command log` と `Server log`、中央の区切りはドラッグで比率変更でき、その比率をローカル保存します。赤いStart/Stopと歯車は自前タイトルバーに置きます。ウィンドウは最後の通常サイズを記憶し、最小サイズは480×480です。フォントはNoto Sans Mono、テーマは `#FFFFFF Soft` が既定で、設定から `#000000 Soft` に切り替えられます。GUIを閉じるとDevRelayと現在の接続processも停止します。詳細は [launcher.md](launcher.md) を参照してください。


## 複数デバイス

複数PCを使う場合は、DevRelay同士をクラスタ化せず、各デバイスのMCPエンドポイントをChatGPTへ別々のプラグイン/コネクタとして登録します。各DevRelayは永続`nodeId`、編集可能なデバイス名、ハードウェアから生成される`defaultName`、aliasesを持ち、ツール結果に自分自身のデバイス情報とオンライン状態を返します。peer API、cluster key、自動peer discovery、他端末へのprocess転送はありません。
