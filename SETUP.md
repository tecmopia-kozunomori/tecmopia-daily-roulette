# 本番セットアップ手順

## 1. Googleスプレッドシートを1つ作る

空のスプレッドシートを作り、URLの `/d/` と `/edit` の間にあるIDを控えます。

## 2. Apps Scriptを作る

1. スプレッドシートまたは script.google.com からApps Scriptプロジェクトを作成。
2. `gas/Code.gs` の内容を貼り付け。
3. プロジェクト設定でマニフェストを表示し、必要なら `gas/appsscript.json` を反映。
4. `Code.gs` 冒頭の以下を変更。

```js
SPREADSHEET_ID: 'ここにスプレッドシートID',
LINE_CHANNEL_ID: 'ここにLINEログインチャネルID',
```

5. エディタ上部で `setup` を選び、1回実行。
6. スプレッドシートに `ROULETTE_LOG` と `PRIZES` ができればOK。

### PRIZESシート

`weight` の数字を変えるだけで当選比率を変更できます。

初期値：

| id | name | weight | enabled |
|---|---|---:|---|
| medal10 | メダル10枚 | 50 | TRUE |
| free1 | クレーンゲーム 1PLAY無料 | 20 | TRUE |
| extra1 | クレーンゲーム 1PLAY増量 | 30 | TRUE |

※数字は合計100でなくても動きます。比率として扱われます。

## 3. GASをウェブアプリ公開

Apps Scriptの「デプロイ」→「新しいデプロイ」→「ウェブアプリ」。

- 次のユーザーとして実行：自分
- アクセスできるユーザー：全員

デプロイ後の `/exec` URL を控えます。

## 4. LINE DevelopersでLIFFを作る

LINEログインチャネル内にLIFFアプリを追加します。

必要なスコープ：

- `openid`（必須。IDトークンをGASで検証するため）
- `profile`（画面に表示名を出したい場合）

エンドポイントURLには、GitHub Pagesで公開するルーレットのURLを設定します。

例：

```text
https://YOUR_GITHUB_NAME.github.io/YOUR_REPOSITORY/
```

発行されたLIFF IDを控えます。

## 5. GitHub側の設定

`js/config.js` を編集します。

```js
LIFF_ID: '発行されたLIFF ID',
GAS_WEB_APP_URL: 'GASの /exec URL',
FORCE_DEMO: false
```

GitHubリポジトリへこのフォルダ内のファイルをすべてアップロードし、GitHub Pagesを有効化します。

## 6. LINE公式アカウントのリッチメニュー

リッチメニューの「毎日ルーレット」領域のアクションをリンクにし、LIFF URLを設定します。

```text
https://liff.line.me/あなたのLIFF_ID
```

おすすめ表示文言：

**毎日1回！テクマくんルーレット**  
**ハズレなし！本日使える特典が必ず当たる！**

## 7. 本番テスト

最低限、以下を確認してください。

1. 1回目は回せる。
2. 抽選後にページを閉じても、再度開くと同じ当選内容が表示される。
3. 同じLINEアカウントで2回目の抽選ができない。
4. 「スタッフ確認後に使用する」で使用済みになる。
5. 使用済み後に再度開くと「本日は利用済み」と表示される。
6. 翌日になると再び回せる。
7. 前日の当選画面を翌日に開いても利用できない。

## セキュリティ上の考え方

フロントからGASへはLINEのIDトークンを送り、GASがLINE公式の検証エンドポイントで正当性を確認したうえで利用者を識別します。

`liff.getProfile()` で得たユーザーIDをそのままGASへ送る方式にはしていません。フロントから送られたユーザーIDをそのまま信用すると、書き換えによるなりすましが可能になるためです。

スプレッドシートには生のLINEユーザーIDを保存せず、ハッシュ化した値のみ保存します。

## 補足

GitHub Pages → Apps Script の通信は、Apps Scriptのデプロイ条件やブラウザ環境によって確認が必要です。もし本番端末でCORS等の問題が出る場合は、UIを変えずに通信部分だけ別方式へ差し替えられます。
