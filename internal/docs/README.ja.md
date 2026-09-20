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

短時間で終了するコマンドは `exec`、開発サーバーやREPLのような長時間プロセスは `process_start` を使います。長時間プロセスの出力は `process_read` の `nextCursor` を次回の `cursor` に渡すことで差分だけ取得できます。

`process_write` はstdin入力、`process_stop` はプロセスツリー停止、`process_list` はDevRelayが保持中のセッション一覧です。

## v0.1で意図的に持たないもの

MCPコアにはPTY、DB、Git専用API、ファイル専用API、Docker専用API、組み込みトンネル、LLM/エージェント機能を含めません。WindowsのランチャーGUIはコアとは分離したローカル制御UIです。CLIで表現できる操作はCLIに任せます。

## Windowsでは2つのランチャーを使う

通常は用途に応じて、プロジェクト直下の `DevRelay ChatGPT.cmd` または `DevRelay HTTPS.cmd` をダブルクリックします。

- `DevRelay ChatGPT.cmd`: GUIをOpenAI Secure MCP Tunnelモードで開きます。
- `DevRelay HTTPS.cmd`: GUIをCloudflare Named Tunnelモードで開きます。

GUIは小さめのEdgeアプリモードで表示され、右上の赤いStart/Stop、左側のAIコマンドログとMCP/トンネルログ、右下の設定を提供します。GUIを閉じるとDevRelayとトンネルも停止します。詳細は [launcher.md](launcher.md) を参照してください。
