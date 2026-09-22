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

通常はプロジェクト直下の `DevRelay.cmd` をダブルクリックします。起動ファイル側では接続モードを選びません。設定パネルの `Mode` が唯一の設定元で、初回は `HTTPS Named Tunnel`、以後は保存した `HTTPS Named Tunnel` / `OpenAI Secure Tunnel` の選択をそのまま復元します。

HTTPSモードでChatGPTなどがOAuth認可を開始すると、設定パネルが自動で開いて接続元・リダイレクト先・scopeを表示します。ローカルGUIでApproveした場合だけ認可コードが発行され、Denyなら拒否されます。公開ブラウザ画面だけでは承認できません。

GUIはOS標準フレームを使わないWPF/WebView2ウィンドウです。本文は `Command log` と `Server log` だけに絞り、中央の区切りはドラッグで比率変更でき、その比率をローカル保存します。赤いStart/Stopと歯車は自前タイトルバーに置きます。ウィンドウは最後の通常サイズを記憶し、最小サイズは480×480です。フォントはNoto Sans Monoで、未導入PCではランチャーがGoogle Fonts公式版を現在ユーザーへ導入します。テーマは `#FFFFFF Soft` が既定で、設定から `#000000 Soft` に切り替えられます。各ウィンドウ起動のログは `internal/.devrelay/logs/` に保存し、直近3回だけ保持します。GUIを閉じるとDevRelayとトンネルも停止します。詳細は [launcher.md](launcher.md) を参照してください。

## 複数デバイス

複数PCを使う場合は、DevRelay同士をクラスタ化せず、各デバイスのMCPエンドポイントをChatGPTへ別々のプラグイン/コネクタとして登録します。各DevRelayは永続`nodeId`、編集可能なデバイス名、ハードウェアから生成される`defaultName`、aliasesを持ち、ツール結果に自分自身のデバイス情報とオンライン状態を返します。peer API、cluster key、自動peer discovery、他端末へのprocess転送はありません。
