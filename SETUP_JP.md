# 他の PC へのセットアップ手順

このアプリ (PotreeDesktop 蒸留版) を別の PC で使うための手順。

## 必要なもの

- Windows 10/11
- Node.js (LTS 版) — https://nodejs.org/ からインストール

## 手順 (5 分)

1. https://github.com/kazusoarer/PotreeDesktop を開く
2. 緑の「Code」ボタン → **Download ZIP** → 好きな場所に展開
   (git が使えるなら `git clone https://github.com/kazusoarer/PotreeDesktop.git` でも可)
3. 展開したフォルダ内の **setup.bat** をダブルクリック (初回のみ。数分かかります)
4. 以後は **PotreeDesktop.bat** で起動
   - デスクトップにショートカットを作る場合: PotreeDesktop.bat を右クリック → 送る → デスクトップ

## 更新方法

ZIP を取り直して上書き展開 (git なら `git pull`)。setup.bat の再実行は不要
(package.json が変わったときだけ再実行)。

## 機能ごとの追加要件

| 機能 | 追加で必要なもの |
|---|---|
| 表示・計測・現場管理・SIMA 読込/出力 | なし (上記だけで動く) |
| 地表分類 等の将来機能 | 案内があればその時に |
| **URL 公開 (Cloudflare)** | メイン PC 専用 (C:\potree_share と Cloudflare 認証が必要)。他 PC では非対応 |

## 現場データの持ち運び

現場は「ドキュメント\Potree現場管理」フォルダに自己完結で入っています。
**現場フォルダごとコピー**すれば別 PC でもそのまま開けます (参照は相対パスのため)。
