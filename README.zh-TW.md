# @polhem/connector

[English](README.md)

[![CI](https://github.com/polhem-dev/polhem-connector-js/actions/workflows/ci.yml/badge.svg)](https://github.com/polhem-dev/polhem-connector-js/actions/workflows/ci.yml)

[Polhem](https://github.com/polhem-dev/polhem) JSON-RPC API 的 JavaScript／TypeScript connector，
包含**加密**的 payload 管線。

## 狀態

**可用，尚未到 1.0。** 每一層都已實作，並以 .NET 伺服端驗證過：密碼學管線對照伺服端產生的 payload，
codec 對照伺服端公開的 wire fixtures，整個堆疊則對執行中的 host 做端到端驗證。1.0 之前 API 仍可能變動。

| 層 | 狀態 |
|----|------|
| AES-CBC-HMAC、gzip、位元組工具 | ✅ 已實作，與 .NET 的輸出交叉驗證 |
| RSA 交握 | ✅ 已實作，雙向交叉驗證 |
| JSON body codec（wire value 封套） | ✅ 以框架的 wire fixtures 驗證 |
| JSON-RPC transport（封套、管線、HTTP） | ✅ |
| 具型別的 connector（`login`、`getList`…） | ✅ |
| API 合約型別，由框架產生 | ✅ 已同步，CI 檢查 |

## 為什麼有這個套件

框架預設的 body codec 是 MessagePack，由逐型別手寫的 formatter 組成。在另一種語言裡照抄一份，
等於替同一份合約建立第二個權威來源，而且沒有任何機制能發現兩者分歧。因此伺服端接受 **JSON body codec**，
瀏覽器端只用平台 API 就能產生——本套件就是那個客戶端。

這裡所有密碼學都是 Web Crypto：AES-256-CBC、HMAC-SHA256、RSA-OAEP（SHA-256），加上平台內建的 gzip stream。
沒有重新實作任何密碼學演算法。

> 如果你的部署可以接受以 HTTPS 作為信任界線，可能根本不需要這個套件——伺服端也接受走 HTTPS 的純 JSON，
> 不需要任何客戶端函式庫。見框架 repo 的
> [ADR-014](https://github.com/polhem-dev/polhem/blob/main/docs/adr/adr-014-jsonrpc-plain-public-default.zh-TW.md)。

## 需求

任何具備 Web Crypto 與 `CompressionStream` 的執行環境：現行瀏覽器，或 Node 18 以上。

## 安裝

**本套件尚未發佈到 npm。** 請從原始碼建置：

```sh
git clone https://github.com/polhem-dev/polhem-connector-js.git
cd polhem-connector-js
npm ci
npm run build
npm pack   # 印出 tarball 名稱 polhem-connector-<version>.tgz
```

再把這個 tarball 安裝到你的專案：

```sh
npm install /path/to/polhem-connector-js/polhem-connector-<version>.tgz
```

目前無法以 Git 網址安裝：建置產物不入版控，也沒有 `prepare` script，裝好的套件會沒有 `dist`。

tarball 內的套件名稱是 `@polhem/connector`，所以下面的 import 會解析到它。

## 使用方式

```ts
import { PolhemClient } from '@polhem/connector';

const client = new PolhemClient({ endpoint: 'https://host/api', apiKey: '…' });

// Signs in, completes the RSA handshake, and installs the session key.
// Every call after this encrypts without being asked.
await client.system.login('demo', 'secret');

const employees = await client.form('Employee').getList({ selectFields: 'sys_id,sys_name' });

await client.system.logout();
```

filter 是由 `FilterGroup` 與 `FilterCondition` 節點組成的樹，以 `kind` 區分。condition 裡的值在伺服端是
`object` 型別，所以 JavaScript 分辨不出來的值要加上標記——沒標記的 decimal 會以字串抵達：

```ts
import { wire } from '@polhem/connector';

await client.form('Employee').getList({
  filter: {
    kind: 'Group',
    operator: 'And',
    nodes: [{ kind: 'Condition', fieldName: 'amount', operator: 'GreaterThan', value: wire.decimal('100') }],
  },
});
```

加上標記的值以 JSON body codec 的區分式封套傳送，因此必須是 Encoded 或 Encrypted 的呼叫——`login` 之後的每個呼叫
都是。Plain 呼叫會拒絕它們：伺服端只依 JSON 種類綁定 Plain 的值，所以 Guid 或日期在那裡仍是字串，數字會成為整數或
decimal，沒有辦法另外指定。

所有訊息型別都以 `Contracts` 匯出（`Contracts.GetListRequest`…），由框架產生。選填成員在 wire 上可能不出現，
不出現即代表 .NET 的預設值（`0`、`false`、列舉的第一個成員、空 Guid）。

### Session 與錯誤

`login` 之前，客戶端不送 `Authorization` header，伺服端將其視為匿名呼叫；是否足夠由該方法自身的存取宣告決定。
`login` 之後每個呼叫都帶 `Bearer <access token>`，`logout` 會清除 token 與 session 金鑰。

伺服端的錯誤以帶有 JSON-RPC `code` 的 `JsonRpcError` 擲出（各值見 `JsonRpcErrorCode`）。當需要登入的呼叫在伺服端
找不到可用的 session（客戶端從未登入，或 token 已過期或被撤銷）時，錯誤是 `AuthenticationRequiredError`
（code `-32001`）。重試沒有用，請重新登入：

```ts
import { AuthenticationRequiredError } from '@polhem/connector';

try {
  await client.form('Employee').getList();
} catch (error) {
  if (error instanceof AuthenticationRequiredError) {
    await client.system.login(userId, password); // replaces the token and the session key
  } else {
    throw error;
  }
}
```

在伺服端 HTTP 閘門被拒絕（API key 缺少或無效、`Authorization` header 格式錯誤）也是 `JsonRpcError`，
其 `httpStatus` 為回應的 HTTP 狀態碼。它不是 `AuthenticationRequiredError`：重新登入也會以同樣方式被拒絕。

### 尚未支援：防重放 frame

部署可以要求每個 Encoded 與 Encrypted payload 內都帶防重放 frame（框架的 `ApiServiceOptions.RequireWireFrame`，
預設關閉）。本客戶端目前既不寫入也不讀取這個 frame，因此在這類部署上，它的 Encoded 與 Encrypted 呼叫（包括 `login`）
會以 `-32005`（`JsonRpcErrorCode.ReplayRejected`）被拒絕，直到支援 frame 為止。Plain 呼叫不受影響。
與本客戶端連線的部署請保持這個開關關閉。

## 開發

```sh
npm install
npm test          # vitest，離線
npm run typecheck # tsc --noEmit
npm run build     # tsup（JS）+ tsc（宣告檔）
npm run test:wire # 下載框架的 wire fixtures，再以它們驗證 codec
npm run contracts:check  # 同步進來的 API 合約仍與框架一致
```

變更如何進入 `main`、框架合約變動時該怎麼做，見 [CONTRIBUTING.zh-TW.md](CONTRIBUTING.zh-TW.md)。

`npm test` 完全不連網：wire 相容性以 .NET 實作產生的固定向量檢查。`npm run test:wire` 是範圍更廣的檢查——
它下載框架公開的 wire fixtures，除了 `value-datatable` 之外的 value 樣本逐一做 round-trip；`value-datatable` 則斷言解碼 `DataTable` 會被拒絕，因為目前尚未支援。這些 fixtures **不入本 repo 的版控**；
複製一份就成了 wire 格式的第二個權威來源，而且會漂移。

### 對真實後端測試

本 repo 不含伺服端。要端到端驗證 connector，請啟動 [polhem](https://github.com/polhem-dev/polhem)
repo 的 quick-start host：

```sh
# 終端機 1 — 在 polhem 的 checkout 裡
dotnet run --project samples/QuickStart.Server

# 終端機 2 — 在這裡
npm run smoke
```

`npm run smoke` 先呼叫 `System.Ping`：以 Plain payload、經 JSON codec 編碼、以及透過具型別的
`client.system.ping()`。接著確認登入前的需驗證呼叫會以 `AuthenticationRequiredError` 失敗，以範例的
`demo` / `demo` 使用者登入（RSA 交握），透過**加密**呼叫讀取表單 schema，確認讀取不存在的 progId
會收到指名該 progId 的 `UserMessage` 錯誤，登出，並確認舊 token 會被拒絕。
指向其他 host 的環境變數列在 `scripts/smoke.mjs` 開頭。

注意單元測試**不**需要伺服端：wire 相容性以 .NET 實作產生的固定向量驗證，所以 `npm test` 可離線執行。

## 授權

MIT
