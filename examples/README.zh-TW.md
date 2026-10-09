# 範例

[English](README.md)

兩支以應用程式的方式使用本套件的小程式：一支跑在 Node，一支跑在瀏覽器。兩者執行同一段流程，寫在 [`demo.mjs`](demo.mjs)：

1. 不登入，呼叫 `System.Ping`。
2. 登入並安裝 session 金鑰；之後的每個呼叫都會加密。
3. 進入公司，表單呼叫需要這一步。
4. 列出 `Staff` 表單。
5. 新增一筆含一支電話的員工資料，讀回來改名並加第二支電話，最後刪除，讓示範資料庫維持原樣。

範例以套件名稱匯入 `@polhem/connector`，會解析到本 repo 的建置結果，所以程式碼就跟在你自己的專案裡一樣。

## 啟動伺服端

範例連到框架的 QuickStart.Server，它允許以 `demo` / `demo` 登入，並且有 `Staff` 表單。請使用本套件驗證過的框架版本，
也就是 [`scripts/framework-ref.mjs`](../scripts/framework-ref.mjs) 裡的 tag：

```sh
git clone --branch <tag> https://github.com/polhem-dev/polhem.git
cd polhem
dotnet run --project samples/QuickStart.Server
```

它監聽 `http://localhost:5050`。

## Node

```sh
npm run example:node
```

這會建置套件並執行 [`node/quickstart.mjs`](node/quickstart.mjs)。要連到其他伺服端，設定 `POLHEM_ENDPOINT`、
`POLHEM_API_KEY`、`POLHEM_USER`、`POLHEM_PASSWORD` 與 `POLHEM_COMPANY`。

## 瀏覽器

```sh
npm run example:browser
```

這會建置套件，並在 <http://localhost:5173/examples/browser/> 提供頁面。打開後按 **Run**；欄位可以改伺服端與帳號。
頁面與 API 位於不同的 origin，QuickStart.Server 允許這種呼叫。

頁面透過 import map 載入套件，不需要打包工具：

```html
<script type="importmap">
  { "imports": { "@polhem/connector": "/dist/index.js" } }
</script>
```

以打包工具建置的應用程式，照常安裝並匯入套件即可。

## 型別檢查

範例是加上 `// @ts-check` 的純 JavaScript。`npm run examples:check` 會對照建置結果檢查型別，CI 也會執行它，
所以 API 變更若讓範例壞掉，建置就會失敗。
