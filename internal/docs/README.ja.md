# DevRelay 日本語クイックスタート

DevRelayは、開発PCのコマンドラインをMCPクライアントから扱うための最小構成のMCPサーバーです。Gitやnpmなどの機能を独自実装せず、既存CLIをそのまま実行する設計です。

## ビルドとテスト

```powershell
cd C:\Users\<user>\Downloads\DevRelay
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

PTY、GUI、Webダッシュボード、DB、Git専用API、ファイル専用API、Docker専用API、組み込みトンネル、LLM/エージェント機能は含みません。CLIで表現できる操作はCLIに任せる方針です。

## Windowsでは2つのランチャーを使う

通常は用途に応じて、プロジェクト直下の `DevRelay ChatGPT.cmd` または `DevRelay HTTPS.cmd` をダブルクリックします。

- `DevRelay ChatGPT.cmd`: OpenAI Secure MCP Tunnel経由で起動します。
- `DevRelay HTTPS.cmd`: Cloudflare Quick Tunnelで一時的な公開HTTPS MCP URLを発行します。

どちらも必要に応じてnpm依存関係の確認とビルドを自動で行います。共通処理は `scripts/DevRelay-Launcher.ps1` にまとめてあり、通常ユーザーが直接実行する必要はありません。旧 `DevRelay.cmd` は整理のため削除しました。詳細は [launcher.md](launcher.md) を参照してください。
