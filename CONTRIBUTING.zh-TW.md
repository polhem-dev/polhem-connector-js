# 參與 polhem-connector-js 開發

[English](CONTRIBUTING.md) | **繁體中文**

變更如何進入這個 repository、由誰合併，寫在
[polhem-dev 組織的貢獻指南](https://github.com/polhem-dev/.github/blob/main/CONTRIBUTING.md)（英文）。本頁補充這個 TypeScript 連接器特有的事項。

這個套件連線的伺服器是 [polhem](https://github.com/polhem-dev/polhem)。wire 格式與 API 合約定義在那裡，不在這裡。

## 建置與測試

```sh
npm ci
npm run contracts:check   # 同步進來的 API 合約仍與框架一致
npm run typecheck
npm test                  # 離線單元測試
npm run build
npm run test:wire         # 下載框架的 wire fixtures，並以它們驗證編解碼器
```

這些就是 CI 執行的步驟，順序相同（見 [`.github/workflows/ci.yml`](.github/workflows/ci.yml)）。
`contracts:check` 與 `test:wire` 會讀取 GitHub；若碰到未驗證請求的速率限制，請設定 `GITHUB_TOKEN`。

`npm run smoke` 會對實際執行中的伺服器跑一輪連接器。它不在 CI 內；如何啟動伺服器見
[README](README.zh-TW.md#對真實後端測試)。

## 框架的 wire 合約變更時

`src/contracts/` 與 wire fixtures 都取自框架的同一個發佈版本，也就是
[`scripts/framework-ref.mjs`](scripts/framework-ref.mjs) 裡的 tag。框架 `main` 上的 wire 變更，要等框架發佈之後才會影響這個
repository。發佈之後：

1. 把 `FRAMEWORK_REF` 改為新的 tag，執行 `npm run contracts:update`。不要手動編輯 `src/contracts/`。
2. 閱讀 diff。屬性改名或移除、或成員變成選填，對這個套件的呼叫端都是破壞性變更。
3. 調整程式碼與測試直到上述檢查通過；行為有變時一併更新 README。

wire fixtures 一律下載、不入版控：在這裡放一份副本，就等於 wire 格式有了第二個權威來源。

## 慣例

- **語言**：程式碼、註解、測試名稱與 commit 訊息使用英文。公開文件（`README`、`CONTRIBUTING`）為雙語：英文檔是來源，
  旁邊的 `.zh-TW.md` 是翻譯，兩份在同一個 pull request 內一起修改。
- **Commit 訊息**：英文、祈使語氣，主旨說明改了什麼；在內文說明原因。
- **相依套件**：本套件沒有執行期相依。所有密碼學運算都使用平台的 Web Crypto 與壓縮串流；不要為此引入函式庫。

## 授權

參與貢獻即表示你同意你的貢獻以 [MIT 授權](LICENSE) 釋出。
