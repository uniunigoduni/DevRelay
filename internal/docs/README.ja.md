# DevRelay 日本語クイックスタート

DevRelayは、開発PCのコマンドラインをMCPクライアントから扱うための最小構成のMCPサーバーです。Gitやnpmなどの機能を独自実装せず、既存CLIをそのまま実行する設計です。

## 設計哲学

DevRelayはリモートIDEでも自律エージェントでもなく、開発環境とMCPクライアントをつなぐ薄いインフラです。開発環境をDevRelayの中へ作り直すのではなく、MCPクライアントを既存の開発環境まで連れてくることを目指します。

能力の源は既存CLIです。Git、ファイル操作、パッケージ管理、Docker、検索などを用途別のMCP APIとして再実装せず、少数の汎用process primitiveから組み合わせて使います。

**MCP surfaceは実用上できるだけ小さく保ちます。** ツール数を減らすこと自体が目的ではなく、必要なworkflowを構成できる最小限の汎用primitiveだけを公開することが目的です。既存のprocess interfaceで自然に表現できない新しいprimitiveが必要な場合にだけ、新しいfirst-class toolを検討します。

MCP/process interfaceは機械向けの実行経路です。Node/Electron GUIは人間向けのcontrol/observation surfaceであり、setup、authorization、lifecycle、settings、diagnosticsを見える形で管理します。GUIを実行APIにはせず、両者の役割を分離します。Windows固有のDPAPI、インストーラー、release bootstrapにはPowerShellを残します。

Windowsが現在の公開サポート対象です。LinuxとmacOS用のGUI、setup、runtime経路を実装中ですが、まだ安定版のサポート対象ではありません。どちらもGitでcloneしたチェックアウトから、Linuxは `DevRelay.sh`、macOSは `DevRelay.app` で起動します。

## ビルドとテスト

```sh
cd internal
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

## 設計上の非目標

MCPコアにはDB、Git専用API、ファイル専用API、Docker専用API、一般的なGUI自動操作API、組み込みトンネル、LLM/エージェント機能を含めません。PTY/ConPTYと画像返却は、CLIだけでは不足する部分を現在の汎用ツールのオプションとして最小限補完します。WindowsのランチャーGUIはコアとは分離した、人間向けのローカル制御・観測UIです。

## 起動ファイル

- **Windows**: プロジェクト直下の `DevRelay.exe` をダブルクリックします。`DevRelay.cmd` は互換用fallbackとして残しています。EXEはコンソールを出さずに既存bootstrapを起動し、Electronのウィンドウは `DevRelay.Desktop` AppUserModelIDを使います。ウィンドウを開く前に最新のpublished GitHub Releaseを確認し、必要ならnpm依存のインストールとビルドを行い、その後にローカルの接続セットアップ状態を確認します。
- **macOS**: チェックアウト内の `DevRelay.app` をダブルクリックします。中身は `DevRelay.sh` を実行します。
- **Linux**: `./DevRelay.sh` を実行します。`./DevRelay.sh --install-desktop-entry` でアプリメニューにDevRelayを追加できます。

`DevRelay.sh` はログインシェルの `PATH` を使うので、Node.js・npm・各providerのCLIはターミナルと同じように見つかります。最初のウィンドウを開く前に必要ならnpm依存のインストールとビルドを行い、ログは `internal/.devrelay/launcher.log` に出します。起動ファイルはチェックアウトの中に置いたまま使ってください。macOSでは `DevRelay.app` を移動せず、Dockに追加するかエイリアスを作ります。ZIPでダウンロードしたチェックアウトはmacOSの隔離属性が付くので、Gitでcloneするか、隔離属性を外してから開いてください。

新規インストールでは通常GUIより先に、ライトテーマの別ウィンドウ **DevRelay Setup** が開きます。接続方式はこのWizardが管理し、メインGUIのSettingsには従来の `Mode` 選択はありません。

接続方式は次の構成です。

- **OpenAI Secure Tunnel**: 構成としては推奨ですが、ChatGPT/tunnel-client側の既知問題があるため現在はExperimental表示です。Wizardはopenai/tunnel-clientの #71、#57、#41 を正式なissue名と番号で表示し、GitHubへ接続できる場合はOPEN/CLOSED状態も非同期で確認します。
- **HTTPS / Tailscale Funnel**: HTTPSでは推奨です。独自ドメインは不要です。WindowsではWizardから公式Tailscaleインストーラーを起動できます。Linuxではディストリビューション向けの公式パッケージ、macOSではTailscaleアプリを先に入れ、その後に通常のブラウザログインとFunnel準備を行います。
- **HTTPS / Cloudflare Named Tunnel**: 固定hostnameを使えますが、CloudflareアカウントとCloudflare管理下のドメインが必要です。Dashboardのブラウザ自動操作はせず、公式 `cloudflared` CLIのログイン・Tunnel作成・DNS routeを使います。
- **HTTPS / Cloudflare Quick Tunnel**: アカウントもドメインも不要ですが、`trycloudflare.com` のURLは一時的で、Tunnel再作成後に変わることがあります。

Wizardの最後にはChatGPTへの登録手順も表示します。OpenAI Secure TunnelではTunnel接続 + MCP側 `No authentication`、HTTPSでは公開 `/mcp` URL + `OAuth` を案内します。HTTPSのOAuth要求が来るとDevRelayメインウィンドウが前面に出て、画面全体を覆うblocking modalでApprove/Rejectします。

別PCへ移行してDCRクライアント登録だけが失われた場合、DevRelay発行形式のclient ID、許可済みChatGPT/OpenAI HTTPSリダイレクトURI、resourceとPKCEを検証した認可要求から登録を復元します。ローカルGUIでの承認は引き続き必要です。refresh tokenの記録は復元されないため、認可を完了して新しいtokenを発行します。

一度セットアップした後は、メインSettingsの `Connection Setup...` から同じ別ウィンドウを再度開けます。新しい接続は準備に成功した時点でChatGPT登録ガイドの表示前に確定します。最後のガイドは **Close** だけで閉じます。確定前にCancel/ウィンドウを閉じた場合はWizard中に変更したローカル接続ファイルを復元します。Advanced ResetはDevRelay側の接続設定だけを消し、Tailscaleのアンインストールやprovider側のremote resource削除は自動では行いません。

GUIはElectronのネイティブウィンドウで、同じHTML/CSS/JavaScript画面を使います。本文は `Command log` と `Server log`、中央の区切りはドラッグで比率変更でき、その比率をローカル保存します。OS標準の枠は使わず、独自のタイトルバーにSTART/STOP、Settings、最小化、最大化/元に戻す、閉じるを表示します。ウィンドウのサイズと位置を保存し、最小サイズは480×480です。Noto Sans Monoがなければ現在のユーザーにインストールし（固定版のGoogle Fontsのファイルを使い、SHA-256で検証します）、テーマは `#FFFFFF Soft` が既定で、設定から `#000000 Soft` に切り替えられます。WaylandではOSが前面化を制限するため、OAuth承認待ちはデスクトップ通知でも知らせます。GUIを閉じるとDevRelayと現在の接続processも停止します。詳細は [launcher.md](launcher.md) を参照してください。

## 複数デバイス

複数PCを使う場合は、DevRelay同士をクラスタ化せず、各デバイスのMCPエンドポイントをChatGPTへ別々のプラグイン/コネクタとして登録します。各DevRelayは永続`nodeId`、編集可能なデバイス名、ハードウェアから生成される`defaultName`、aliasesを持ち、ツール結果に自分自身のデバイス情報とオンライン状態を返します。peer API、cluster key、自動peer discovery、他端末へのprocess転送はありません。
